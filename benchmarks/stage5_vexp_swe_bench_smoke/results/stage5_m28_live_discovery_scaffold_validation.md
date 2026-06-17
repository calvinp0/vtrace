# Stage 5 — M28.1 live validation of the strict fair-test-discovery scaffold

**Date:** 2026-06-17
**Milestone under test:** M28 (`660b171` "Require fair test discovery evidence")
**Label:** `eval-m28-discovery-current-sphinx-7462-r1`
**Instance:** `sphinx-doc__sphinx-7462`
**Mode:** live `run-protocol` (real agent) + offline `plan-agent-test-command` + offline `verify-agent-test-command`
**Docker:** NOT run. `--allow-docker-verify` NOT passed.

Conditions: `--protocol vtrace-indexed --capsule-intent auto --capture-product-v2-accounting
--disable-pivot-check --pivot-inspection-enforcement --pivot-revision-pass
--revision-verification-policy agent-discovered-tests`.

Only `r1` was run (it was valid, the revision phase ran, and a test command was produced — so the
brief's r2 trigger conditions did not apply).

---

## 1. Executive verdict

**M28 did NOT produce a planner-eligible fair command.** The revision command is ineligible for
future fair execution with **two** planner blockers (`ambiguous` provenance + a shell pipe), and —
more seriously — **the revision prompt leaked a literal FAIL_TO_PASS test name** (`test_unparse[()-()]`)
through the M12 pivot-inspection "Conflict evidence" line, despite the M28 fair-verification block
correctly withholding evaluator labels elsewhere in the same prompt. The leak undermines the
fairness premise of the experiment: it plausibly steered the agent's repo search toward the file
that contains that test.

---

## 2. Run validity

| Field | Value |
| --- | --- |
| Label | `eval-m28-discovery-current-sphinx-7462-r1` |
| Run valid | **yes** — `Treatment valid: true`, model patch produced |
| First-pass patch | yes (54 lines), `vtraceContextInjected: true` |
| Revision phase ran | **yes** — hard-gate pivot-revision second pass spawned a real agent (31 turns, ~111s, $0.64) and wrote a revised patch |
| Docker eval | **not run** (per brief) |
| `--allow-docker-verify` | **not passed** |

---

## 3. Prompt fairness (`_pivot_revision_prompt.md`)

| Required check | Result | Evidence |
| --- | --- | --- |
| Literal FAIL_TO_PASS names absent | **FAIL** | Line 55: `Conflict evidence: symbol "unparse" matches FAIL_TO_PASS test test_unparse[()-()]` — a literal evaluator label leaked into the prompt |
| Repo-test discovery protocol present | PASS | Lines 72–76: "Search/list/read the repository test files… grep/ripgrep/find/ls over the test directories, then read the candidate test file" |
| "Do not guess from function name" present | PASS | Line 70: "Do not guess a test name from the edited function name alone." |
| Canonical unpiped pytest instruction present | PASS | Lines 78–86: "Prefer `python -m pytest <node>`… Avoid piping or truncating the test command (e.g. `… \| head`, `2>&1 \| head`)" |
| Anti-over-edit guardrails present | PASS | Lines 49–51, 117–121: "Do not edit a file merely because it is listed", "Prefer the minimal final diff", "Only add a co-edit file when source/test evidence requires it" |

The M28 fair block itself is well-formed and does withhold labels (line 63 "Benchmark/evaluator test
labels are withheld under the fair verification policy"; line 86 "test names copied from
benchmark/evaluator labels (they are withheld here)"). **The leak is not in the M28 block** — it
enters via the M12/M13 enforcement *corrective* prompt (`pivotInspectionCompliance.buildCorrectivePrompt`),
whose "Conflict evidence" line is not subject to the fair-policy `omitInjectedTestNames` suppression
applied in `pivotRevisionPass.renderTestExpectation`.

---

## 4. Discovery chain

Source: `_pivot_revision_tool_calls.json` (13 ordered calls) and `_pivot_revision_test_commands.json`.
Relevant calls — `[0,1] read sphinx/pycode/ast.py`, `[2] edit ast.py`, `[3] edit python.py`,
`[4] read python.py`, `[5,6] edit python.py`, `[7] Grep over tests/`, `[8] pytest (piped)`,
`[9,10] python -c smoke checks`, `[11] py_compile`, `[12] git diff`.

| Step | Observed? | Command / tool | Evidence |
| --- | --- | --- | --- |
| repo-test search/list | **Partial** | `Grep` (tool) over `…/tests` | Output: `Found 1 file\ntests/test_pycode_ast.py`. A search ran and its **output** surfaced the test file, but the Grep pattern/path does not name the file leaf, so the classifier does not credit it as a file-targeted `searched` signal. |
| test-file read / output | **Output only** | (no `cat`/`read` of the test file) | No read of `tests/test_pycode_ast.py`. Classifier records "prior output surfaced the selected test node", but there is no `search→read` chain on the test file. |
| test command | **yes** | `python -m pytest tests/test_pycode_ast.py -v 2>&1 \| head -60` | Ran against the whole test file (errored at import — `parsedOutcome.status=error`, traceback in env). |
| canonical command | **no** | — | The only test command was piped/redirected; no bare `python -m pytest <node>` was issued. |
| pipeline / redirect | **yes (present)** | `… 2>&1 \| head -60` | Triggers `commandSafety.diagnosticOnly`. |

---

## 5. Planner / verifier results

Planner: `_agent_test_command_plan.json` (`--patch-source pivot_revision_revised`,
`--command-source pivot_revision_test_commands`). Verifier run **without** `--allow-docker-verify`.

| Field | Value |
| --- | --- |
| `eligibleForFutureExecution` | **false** |
| provenance (`fairProvenance.classification`) | **ambiguous** — evidence: "prior output surfaced the selected test node"; "exploration present but no search→read/output discovery chain" |
| `allowedForFairVerification` | **false** |
| `commandSafety` | `allowed:false`, `diagnosticOnly:true`, reason: `shell pipeline/redirect token "\|" — not fair-executable as captured` |
| `blockers` | (1) `provenance "ambiguous" is not allowed for fair verification`; (2) `command not fair-executable as captured: shell pipeline/redirect token "\|"` |
| `selectedTests` | `["tests/test_pycode_ast.py"]` |
| `expectedImageKey` | `swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7462:latest` |
| `patchSha256` | `5227bf13e581230217f26aa94f022a0b891c0835d83cea2c5659ac133b260a67` |
| Verifier status (no Docker) | **skipped — `plan_ineligible`** (Gate 1). `dockerStarted:false`, `commandExecuted:false`, `canonicalArtifactsUntouched:true` |

Note: the verifier skipped at Gate 1 (`plan_ineligible`) and therefore **never reached** the
Gate 4 `docker_not_authorized` skip. The "best case" outcome (eligible plan → `docker_not_authorized`)
was not exercised because the plan was ineligible first.

---

## 6. Interpretation

- **Did the stronger scaffold induce real discovery?** *Partially, and contaminated.* The agent did
  run a `Grep` over `tests/` whose output surfaced `tests/test_pycode_ast.py` — more exploration than
  a bare function-name guess. But it then ran a piped pytest over the whole file **without reading the
  test file**, so the strict M28 classifier (which needs `searched && (read || output)` with the
  search tied to the file) scores it `ambiguous`, not `agent_discovered`. Worse, the prompt leaked the
  literal FAIL_TO_PASS name `test_unparse`, which lives inside `test_pycode_ast.py` — so the "discovery"
  cannot be trusted as independent of the evaluator label.
- **Did the command become planner-eligible?** **No.** Two blockers: `ambiguous` provenance and the
  `2>&1 | head -60` pipe.
- **If not, what single blocker remains?** There is no single blocker — there are three issues,
  ranked: (1) **prompt FAIL_TO_PASS leak** (fairness-integrity bug; dominates), (2) shell pipe in the
  test command (command-safety), (3) no read of the test file → `ambiguous` provenance. The leak must
  be fixed first because it invalidates the discovery signal that the other two gates are meant to
  measure.

---

## 7. Next recommendation

**D — Fix sanitization.** The revision prompt leaked a literal FAIL_TO_PASS label
(`test_unparse[()-()]`) via the M12/M13 enforcement "Conflict evidence" line. Under the
`agent-discovered-tests` fair policy this path must honor the same label-withholding that
`pivotRevisionPass.renderTestExpectation` already applies — route the M12 conflict-evidence
rendering through the fair-policy suppression so evaluator test labels never reach the prompt.

The pipe blocker (recommendation **B**) and the missing test-file read (`ambiguous` provenance) are
real but secondary: they cannot be honestly evaluated until the leak is removed, because the leak
plausibly steered the agent's repo search toward the file containing the named test. Re-run this same
single label after the sanitization fix before considering any Docker step.

No M29 / `--allow-docker-verify` is warranted (plan is ineligible). No 30/100 sweep.

---

## Provenance & guardrails

- No Docker run; `--allow-docker-verify` never passed; verifier skipped before any container start
  (`canonicalArtifactsUntouched:true`).
- Report-only; **no source/benchmark code changed** in this validation.
- Raw run artifacts under `runs/<label>/raw/` left untracked (not staged).
