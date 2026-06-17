# Stage 5 — M29: Diagnostic isolated agent-command verifier (first real non-oracle execution)

First live exercise of `--mode verify-agent-test-command --allow-docker-verify` against a
planner-eligible label. Goal: run **one** diagnostic isolated verifier execution — agent-selected
command, in the per-instance SWE-bench testbed, with the selected patch applied, parsing only that
command's output, **never** touching SWE-bench grading/oracle scoring or canonical artifacts.

## 1. Executive verdict

**SUCCESS — `agent_selected_test_passed`, with `final_patch_verified`.**

The non-oracle isolated runner works end-to-end. After two seam/swebench-version integration fixes
(below), the verifier pulled the prebuilt per-instance image, started the container, applied the
revised patch, ran the agent-selected pytest command, and parsed a **pass** — all without invoking
any oracle grading and without mutating any canonical artifact.

| Field | Value |
|---|---|
| `status` | `verified` |
| `dockerStarted` | `true` |
| `commandExecuted` | `true` |
| `patchSource` | `pivot_revision_revised` |
| `patchSha256` | `ec96de0e…90cd` (matches planner) |
| `parsedOutcome.status` | `passed` (high confidence, "1 passed in summary") |
| `environmentClassification` | `test_passed` (targetTestExecuted=true) |
| `finalPatchProof.classification` | `final_patch_verified` / `canVerifyFinalPatch=true` |
| `oracleGradingUsed` | `false` |
| `canonicalArtifactsUntouched` | `true` |
| `replacementRecommended` / `canonicalReplaced` | `false` / `false` |
| `fairVerificationUsable` | **`false`** — single blocker: verifier's own provenance recompute = "ambiguous" |

Caveat (honest): `fairVerificationUsable=false`. The pass and the final-patch proof are solid, but
the verifier's independent `assessFairVerification` provenance recompute downgraded provenance to
`ambiguous` and therefore disallows *fair* verification — even though the M26 planner had classified
this same case `agent_discovered_hidden_match` / `allowedForFairVerification=true`. This is the
documented "recompute can only DISALLOW" seam disagreeing with the planner. See §6/§8.

## 2. Input label and planner eligibility

```
label:           eval-m28-strong-discovery-current-sphinx-7462-r1
instanceId:      sphinx-doc__sphinx-7462
patchSource:     pivot_revision_revised   (command-source: pivot_revision_test_commands)
selectedCommand: python -m pytest tests/test_domain_py.py::test_parse_annotation -v
selectedTests:   tests/test_domain_py.py::test_parse_annotation
commandFramework: pytest        commandSafety.allowed: true
eligibleForFutureExecution: true   blockers: []
planner provenance: agent_discovered_hidden_match (allowedForFairVerification=true)
expectedImageKey: swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7462:latest
plan patchSha256: ec96de0e3a8ae8564c7daf5456e78e26b70210d2bf5fd8f1e7aee1dcc6da90cd
```

Eligibility was already established by M28.7 (the `docker_not_authorized` skip). M29 supplied
`--allow-docker-verify` to advance past Gate 4 into real container execution.

## 3. Docker/testbed execution path

The first two attempts surfaced two genuine seam ↔ swebench-4.1.0 integration bugs (Docker never
started in either — pure infra, not patch/test signal):

1. **`ImportError: cannot import name 'GIT_APPLY_CMDS' from 'swebench.harness.constants'`.**
   In swebench ≥4.x this constant moved into `swebench.harness.run_evaluation` — which transitively
   imports the grading path, so importing it from there would have **broken the non-oracle
   guarantee**. Fix: inline the 3-element `GIT_APPLY_CMDS` list locally in the seam.

2. **`BuildImageError: Environment image sweb.env.py.x86_64.<hash> not found`.** `build_container`
   with no namespace only builds the *instance* layer and requires the *env* image (and base) to
   pre-exist; on a clean machine that chain is absent. The planner already derived the correct
   **remote** image (`swebench/…_1776_…`); the seam was building locally instead of pulling it.
   Fix: pass `namespace="swebench"` to `make_test_spec` so `TestSpec.is_remote_image` is true and
   `build_container` **pulls** the prebuilt per-instance image — matching the planner's
   `expectedImageKey` exactly.

After both fixes the third run executed the real path:

```
pulled  swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7462:latest   (3.81GB)
created container 2b6730961aef…   started OK   dockerStarted=true
applied _pivot_revision_revised.patch via GIT_APPLY_CMDS   patchApplied=true
exec  /bin/bash -lc "python -m pytest 'tests/test_domain_py.py::test_parse_annotation'"
commandRan=true   rawToolSuccess=true (not timed out)
cleanup_container OK
```

Image pulled = exactly the planner's `expectedImageKey`. Execution stayed strictly within the M25
non-oracle seam: `make_test_spec → build_container(pull) → copy_to_container → GIT_APPLY_CMDS →
exec_run_with_timeout → cleanup_container`. It stopped before `eval_script` / grading.

## 4. Non-oracle boundary check

Confirmed the execution path does **not** call or produce any oracle scoring:

- Seam's executed swebench imports: `constants` (DOCKER_*/KEY_INSTANCE_ID/UTF8), `docker_build`
  (`build_container`, `setup_logger`), `docker_utils` (`copy_to_container`,
  `exec_run_with_timeout`, `cleanup_container`), `test_spec` (`make_test_spec`), `utils`
  (`load_swebench_dataset`). **No** `swebench.harness.grading`, `get_eval_report`,
  `get_resolution_status`, `run_instance`, or `eval_script`. (Every occurrence of those tokens in
  the seam is in a docstring/comment, not executed code.)
- The seam ran **our** canonicalized command, NOT `test_spec.eval_script` (which leads to grading).
- It consumed **no** FAIL_TO_PASS / PASS_TO_PASS data; it emits raw command stdout + a local
  pytest-summary parse only.
- No `resolved` scoring, no canonical evaluation JSONL update, no shadow-eval metadata update
  (see §7).

## 5. Patch-state proof

```
finalPatchProof.patchSource                 = pivot_revision_revised
finalPatchProof.patchSha256                 = ec96de0e3a8ae8564c7daf5456e78e26b70210d2bf5fd8f1e7aee1dcc6da90cd
finalPatchProof.patchApplied                = true
finalPatchProof.commandRanAfterPatchApply   = true
finalPatchProof.worktreeDiffHashBeforeCommand = bb441ee42fe472ec71726579c1fa8f9d7f632cf039aa603704eb55cb08a0959d
finalPatchProof.worktreeDiffHashAfterCommand  = bb441ee42fe472ec71726579c1fa8f9d7f632cf039aa603704eb55cb08a0959d
finalPatchProof.evidence = [
  "planned patch applied to the testbed before the command",
  "command executed after the patch was applied",
  "applied patch sha256 ec96de0e…90cd matches the planned patch"
]
verificationPatchState.classification   = final_patch_verified
verificationPatchState.canVerifyFinalPatch = true
```

All four expected conditions hold: `patchApplied=true`, `commandRanAfterPatchApply=true`,
`canVerifyFinalPatch=true`, `classification=final_patch_verified`. The container-applied patch SHA
matches the planner's planned SHA byte-for-byte. The worktree diff hash is **identical before and
after** the command — i.e. the agent-selected test ran read-only against the patched tree and did
not mutate it. This is a true final-patch verification, not a verifier failure.

## 6. Command output and parsed outcome

```
exitCode              = null      (seam limitation — see note)
rawToolSuccess        = true      (exec_run_with_timeout did not time out)
stdout present?       = yes       stderr present? = no (empty)
parsedOutcome.status  = passed
parsedOutcome.evidence = ["1 passed in summary"]   confidence = high
environmentClassification.classification = test_passed   targetTestExecuted = true
outcomeMismatch       = false
fairVerificationUsable = false
fairVerificationBlockers = ["provenance \"ambiguous\" is not allowed for fair verification"]
```

Captured testbed stdout (verbatim, abridged):

```
platform linux -- Python 3.9.20, pytest-8.3.3 …  rootdir: /testbed  configfile: setup.cfg
collected 1 item
tests/test_domain_py.py .                                                [100%]
======================== 1 passed, 7 warnings in 0.06s =========================
```

Interpretation is scoped strictly to the isolated command: **the agent-selected test
`tests/test_domain_py.py::test_parse_annotation` PASSED with the revised patch applied.** No
SWE-bench resolution is inferred.

Two honest notes:
- `exitCode=null`: the seam derives success from `exec_run_with_timeout`'s timeout flag
  (`rawToolSuccess`) and does not capture a numeric exit code; the parsed pytest summary
  ("1 passed") is the authoritative pass signal here. Minor diagnostic gap, not a correctness issue.
- `fairVerificationUsable=false`: the verifier's own `assessFairVerification` recomputed provenance
  as `ambiguous` (the single blocker) and disallowed fair verification. The M26 planner had this
  case as `agent_discovered_hidden_match` / allowed. So the final-patch proof passes but the *fair*
  gate, recomputed conservatively at verify time, does not. See §8.

## 7. Canonical artifact safety

```
canonicalArtifactsUntouched = true        (before/after tamper hash equal across every write)
canonical result row swebench-2026-06-17.jsonl: resolved = null   (verifier set NO resolution)
_eval.meta.json                              : absent  (no post-evaluate oracle artifact produced)
git status of results/runs/                  : "?? results/runs/"  (entirely untracked; nothing staged/mutated)
replacementRecommended / canonicalReplaced   : false / false
```

The verifier wrote only `_`-prefixed diagnostic artifacts under `raw/vtrace/`
(`_agent_test_command_verify.{meta.json,stdout.txt,stderr.txt,exec.json}` and the traceability
`_agent_test_command_plan.json`). The canonical `resolved` field stayed `null`; no canonical
evaluation JSONL, shadow-eval meta, or pivot-revision record was changed. The only **tracked** file
modified by this task is the seam script `verify_agent_test_command.py` (§9). The pre-existing dirty
`stage5_outcome_ledger.*` / `stage5_retrieval_eval_cross_repo_30.*` files predate this work and were
not touched.

## 8. Interpretation

- The isolated, non-oracle verifier path is **functional**: it pulls the correct planner-derived
  per-instance image, applies the selected patch via SWE-bench's own GIT_APPLY_CMDS, runs exactly
  the agent-selected command, and parses only that output — with a verified before/after tamper
  hash proving canonical safety.
- For this case the revised patch is **sufficient** for the agent-selected test:
  `test_parse_annotation` passes in the patched testbed, and the final-patch proof is complete
  (`final_patch_verified`).
- The remaining gap is policy, not plumbing: the verifier's provenance recompute (`ambiguous`)
  disagrees with the planner's `agent_discovered_hidden_match`. The two code paths derive provenance
  from different inputs at plan time vs. verify time, and the verify-time recompute is intentionally
  conservative (can only disallow). This means `fairVerificationUsable` will be `false` for this
  label until that provenance disagreement is reconciled — worth tracking, but it does **not**
  undermine the final-patch proof or the pass signal.
- No SWE-bench resolution is claimed. The only claim is: the agent-selected command passed in the
  isolated environment with the revised patch applied.

No original-vs-revised comparison was performed. (The primary run succeeded, but reaching that
success required a seam source change, so per the task's gate the optional `original_model_patch`
comparison was deliberately deferred to the next step.)

## 9. Next recommendation

**A. Run one comparison verification on `original_model_patch` for the same command.**

Rationale: the agent-selected revised-patch command passed *with* a complete final-patch proof
(`final_patch_verified`, SHA-matched, read-only worktree). The natural next diagnostic is to run the
identical canonical command against `--patch-source original_model_patch` in the same isolated
testbed and compare — establishing whether the test discriminates revised-vs-original. (Hold until
explicitly approved; it is one more Docker execution.) Alongside it, reconcile the verify-time vs.
plan-time provenance disagreement so `fairVerificationUsable` reflects the planner's
`allowedForFairVerification` where appropriate.

### Code changed in this task

Source change required (small verifier/testbed integration fix):
`benchmarks/stage5_vexp_swe_bench_smoke/verify_agent_test_command.py`
- Inline `GIT_APPLY_CMDS` (moved out of `swebench.harness.constants` in swebench ≥4.x; importing it
  from `run_evaluation` would pull the grading path and break the non-oracle boundary).
- Add `--namespace` (default `swebench`) and pass it to `make_test_spec` so `build_container` pulls
  the prebuilt per-instance image (matching the planner's `expectedImageKey`) instead of attempting
  a local base→env→instance build.

Verification: `bun run typecheck`, `bun run typecheck:benchmarks` clean; `bun test` = 2837 pass / 0
fail; seam `py_compile` OK; `git diff --check` clean. No scoring / candidate generation / Capsule v2
ranking / retrieval change. Revision pass remains non-default; revised patches were **not** wired
into canonical evaluation.
