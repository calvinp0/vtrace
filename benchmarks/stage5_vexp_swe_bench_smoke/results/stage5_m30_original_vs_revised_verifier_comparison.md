# Stage 5 — M30: Original vs Revised Diagnostic Verifier Comparison

Diagnostic, non-oracle, command-level verification only. No live agents, no SWE-bench
canonical evaluation, no oracle grading, no adoption. Both patch sources were verified
through the **same** captured agent-selected command (`command-source =
pivot_revision_test_commands`) in the isolated SWE-bench container seam
(`make_test_spec → build_container → copy_to_container → GIT_APPLY_CMDS →
exec_run_with_timeout → cleanup`, STOPPING before `grading.py` / `get_eval_report`).

## 1. Executive verdict

**Classification: `non_discriminative_both_pass`.**

The single agent-selected command — `tests/test_domain_py.py::test_parse_annotation` —
**passes under both the original/canonical model patch and the pivot-revision revised
patch** (each: `1 passed, 7 warnings in 0.05s`). The command therefore provides **no
evidence that the revision improves (or harms) anything**. `fairVerificationUsable` is
`true` on both sides and oracle grading was never invoked. This is *not* improvement
evidence; the next step is to find a more discriminative command/label (recommendation B).

## 2. Input label and eligibility proof

| Field | Value |
| --- | --- |
| Label | `eval-m29-candidate-current-sphinx-7462-r1` |
| Instance | `sphinx-doc__sphinx-7462` |
| Command source (both sides) | `pivot_revision_test_commands` |
| Selected test | `tests/test_domain_py.py::test_parse_annotation` |
| Captured command | `python -m pytest tests/test_domain_py.py::test_parse_annotation -v 2>&1` |
| Canonical command (planner) | `python -m pytest tests/test_domain_py.py::test_parse_annotation -v` |
| Expected image key | `swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7462:latest` |
| `eligibleForFutureExecution` | `true` |
| `fairProvenance.classification` | `agent_discovered_hidden_match` |
| `allowedForFairVerification` | `true` |
| `commandSafety.allowed` | `true` |
| `commandCanonicalized` | `true` |
| Original model patch sha256 | `6aca9946…539f` |
| Revised patch sha256 | `07c5bf23…c917` |

Source for the above: `raw/vtrace/_agent_test_command_plan.json` (the planner is re-run as
the first stage of each verify invocation; it gated `eligible` with `blockers: []`).

## 3. Revised-patch verification

Artifacts: `_agent_test_command_verify.pivot_revision_revised.{meta.json,stdout.txt,stderr.txt,exec.json}`

| Check | Value |
| --- | --- |
| `patchSource` | `pivot_revision_revised` |
| `patchSha256` | `07c5bf238b9fffa0227c24971bb4bd5b8293dc481c9f1aa8d6710bc4b658c917` |
| `patchApplied` | `true` |
| `commandRanAfterPatchApply` | `true` |
| `capturedCommand` | `python -m pytest tests/test_domain_py.py::test_parse_annotation -v 2>&1` |
| `canonicalCommand` (planner) | `python -m pytest tests/test_domain_py.py::test_parse_annotation -v` |
| `executedCommand` (seam) | `python -m pytest 'tests/test_domain_py.py::test_parse_annotation'` |
| `commandCanonicalized` | `true` |
| `canonicalizationReason` | `rebuilt from parsed pytest framework + 1 selected test(s); raw captured shell pipeline discarded` |
| `selectedTests` | `["tests/test_domain_py.py::test_parse_annotation"]` |
| `parsedOutcome.status` | `passed` |
| `parsedOutcome.evidence` | `["1 passed in summary"]` (`1 passed, 7 warnings in 0.05s`) |
| `environmentClassification` | `test_passed` |
| `targetTestExecuted` | `true` |
| `verificationPatchState.classification` | `final_patch_verified` |
| `canVerifyFinalPatch` | `true` |
| `fairVerificationUsable` | `true` |
| `fairVerificationBlockers` | `[]` |
| `canonicalArtifactsUntouched` | `true` |
| `oracleGradingUsed` | `false` |

## 4. Original-patch verification

Artifacts: `_agent_test_command_verify.original_model_patch.{meta.json,stdout.txt,stderr.txt,exec.json}`

| Check | Value |
| --- | --- |
| `patchSource` | `original_model_patch` |
| `patchSha256` | `6aca9946519543a6235fae2b3ccd4b706ed8ea4ea633d17e923fd6bd9914539f` |
| `patchApplied` | `true` |
| `commandRanAfterPatchApply` | `true` |
| `capturedCommand` | `python -m pytest tests/test_domain_py.py::test_parse_annotation -v 2>&1` |
| `canonicalCommand` (planner) | `python -m pytest tests/test_domain_py.py::test_parse_annotation -v` |
| `executedCommand` (seam) | `python -m pytest 'tests/test_domain_py.py::test_parse_annotation'` |
| `commandCanonicalized` | `true` |
| `canonicalizationReason` | `rebuilt from parsed pytest framework + 1 selected test(s); raw captured shell pipeline discarded` |
| `selectedTests` | `["tests/test_domain_py.py::test_parse_annotation"]` |
| `parsedOutcome.status` | `passed` |
| `parsedOutcome.evidence` | `["1 passed in summary"]` (`1 passed, 7 warnings in 0.05s`) |
| `environmentClassification` | `test_passed` |
| `targetTestExecuted` | `true` |
| `verificationPatchState.classification` | `final_patch_verified` |
| `canVerifyFinalPatch` | `true` |
| `fairVerificationUsable` | `true` |
| `fairVerificationBlockers` | `[]` |
| `canonicalArtifactsUntouched` | `true` |
| `oracleGradingUsed` | `false` |

## 5. Original vs revised comparison table

| Dimension | Original (`6aca9946…`) | Revised (`07c5bf23…`) | Same? |
| --- | --- | --- | --- |
| Patch applied | `true` | `true` | ✓ |
| Command ran after apply | `true` | `true` | ✓ |
| Executed command | `python -m pytest 'tests/test_domain_py.py::test_parse_annotation'` | same | ✓ |
| `parsedOutcome.status` | `passed` | `passed` | ✓ |
| pytest summary | `1 passed, 7 warnings in 0.05s` | `1 passed, 7 warnings in 0.05s` | ✓ |
| `environmentClassification` | `test_passed` | `test_passed` | ✓ |
| `targetTestExecuted` | `true` | `true` | ✓ |
| `canVerifyFinalPatch` | `true` | `true` | ✓ |
| `fairVerificationUsable` | `true` | `true` | ✓ |
| `fairVerificationBlockers` | `[]` | `[]` | ✓ |

**Both pass.** The selected command does not separate the two patch states.

## 6. Non-oracle boundary

Confirmed that **neither** verification calls or produces any of the prohibited oracle
signals. A grep over every produced verify artifact
(`_agent_test_command_verify.*.{meta.json,exec.json,stdout.txt}`) returned **no** matches
for `get_eval_report`, `get_resolution_status`, `resolved` scoring, `FAIL_TO_PASS`,
`PASS_TO_PASS`, `eval_report`, or `resolution_status`. The seam script
(`verify_agent_test_command.py`) imports **no** grading / report / resolution module
(those tokens appear only in its header comments documenting what it deliberately avoids).
No canonical evaluation JSONL update and no shadow-eval metadata update occurred.

- `get_eval_report` — not called / not produced ✓
- `get_resolution_status` — not called / not produced ✓
- `resolved` scoring — not computed ✓
- `FAIL_TO_PASS` scoring — not computed ✓
- `PASS_TO_PASS` scoring — not computed ✓
- canonical evaluation JSONL update — none ✓
- shadow eval metadata update — none ✓

`oracleGradingUsed = false` for both patch sources.

## 7. Canonical artifact safety

`canonicalArtifactsUntouched = true` for both runs — the runner's own before/after
tamper check (`hashVerifyProtectedArtifacts`, covering the canonical results JSONL, the
pivot-revision record `_pivot_revision.json`, and the shadow-eval meta) passed on each
invocation; a mismatch would have aborted the run.

- The diagnostic verifier writes only `_`-prefixed, untracked artifacts under
  `runs/<label>/raw/vtrace/`. None are git-tracked; none were staged.
- To avoid one side overwriting the other (the runner writes fixed filenames
  `_agent_test_command_verify.{meta.json,stdout.txt,stderr.txt,exec.json}`), each side's
  outputs were copied to source-suffixed names
  (`…verify.pivot_revision_revised.*` and `…verify.original_model_patch.*`) immediately
  after that side ran. Both comparison sides are preserved.
- The only git-tracked result files showing as modified
  (`stage5_outcome_ledger.json` / `.md`) were **already dirty at session start**
  (mtime 15:46, predating this work's verify runs at ~17:30) and were **not** touched by
  this task.

## 8. Interpretation

The revised patch is a conservative second-pass variant of the canonical first-pass
patch. The one command the agent selected exercises `test_parse_annotation`, which the
canonical patch **already satisfies**, so the revision changes nothing observable through
this command — hence identical `passed` / `test_passed` / `final_patch_verified` on both
sides. `final_patch_verified` here certifies *patch-applied-then-command-ran provenance*,
**not** SWE-bench resolution; no resolution claim is inferred from this run.

Operational note (verifier seam): the first revised attempt errored with
`ModuleNotFoundError: No module named 'docker'` because the runner shells the seam as the
bare interpreter `python` (`pythonCommand: "python"`), which resolved to a system Python
without the `docker` SDK. Re-running with the vexp harness venv first on `PATH`
(`/home/calvin/code/vexp-swe-bench/.venv/bin`, `docker 7.1.0`) produced a clean Docker
seam execution for both sides. No source change was made; this is recorded as a seam
invocation prerequisite, not a comparison result.

## 9. Next recommendation

**B — non_discriminative_both_pass: find a more discriminative command or label; do not
use this as improvement evidence.**

The selected command cannot distinguish original from revised because both pass it. To
produce command-level evidence that the revision matters, identify a command/label where
the original patch's selected command **fails** while the revised patch's command
**passes** (i.e. a `revision_improves_agent_command` candidate). Until such a
discriminative case exists, this label must **not** be cited as revision-improvement
evidence, and no replacement signal / adoption follows from it.

---

_Diagnostic only. `replacementRecommended = false`, `canonicalReplaced = false` on both
artifacts. No adoption, no canonical evaluation, no oracle grading._
