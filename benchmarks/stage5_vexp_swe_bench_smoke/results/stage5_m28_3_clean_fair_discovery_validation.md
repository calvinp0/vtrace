# Stage 5 — M28.3 clean live rerun of fair test discovery (post-sanitization)

**Date:** 2026-06-17
**Milestone:** M28.3 (clean live rerun after M28.2 conflict-evidence sanitization `d0fb008`)
**Label:** `eval-m28-clean-discovery-current-sphinx-7462-r1`
**Instance:** `sphinx-doc__sphinx-7462`
**Mode:** live `run-protocol` + offline `plan-agent-test-command` + offline `verify-agent-test-command`
**Docker:** NOT run. `--allow-docker-verify` NOT passed.

Conditions: `--protocol vtrace-indexed --capsule-intent auto --capture-product-v2-accounting
--disable-pivot-check --pivot-inspection-enforcement --pivot-revision-pass
--revision-verification-policy agent-discovered-tests`. Only `r1` was run (valid, revision
ran, test command produced — so r2 was not triggered).

---

## 1. Executive verdict

**The prompt is now fully sanitized (no leak regression), but M28 still does NOT produce a
planner-eligible fair command.** The agent's revision pass selected the exact FAIL_TO_PASS
test (`tests/test_domain_py.py::test_parse_annotation`) via a grep-only discovery — without
reading the test file — and ran it with a `2>&1` redirect. The planner is **ineligible**
with two blockers: provenance `injected_metadata` (the selected test coincides with a hidden
evaluator label and there is no credited search→read discovery chain) and a non-canonical
(redirected) command.

**Classification: `clean_prompt_discovery_blocked`** (with a secondary command-safety blocker).

---

## 2. Run validity

| Field | Value |
| --- | --- |
| Label | `eval-m28-clean-discovery-current-sphinx-7462-r1` |
| Run valid | **yes** — `Treatment valid: true`, `Rerun recommended: no` |
| First-pass patch | yes |
| Revision phase ran | **yes** — pivot-revision second pass spawned a real agent (26 turns, ~84s, $0.51), produced a 38-line revised patch (`patchSha256 2ac93bf…`) |
| Docker eval | **not run** |
| `--allow-docker-verify` | **not passed** |
| Telemetry artifacts | all present (`_pivot_revision_prompt.md`, `_pivot_revision_tool_calls.json`, `_pivot_revision_test_commands.json`, `_agent_test_command_plan.json`, `_agent_test_command_verify.meta.json`) |

---

## 3. Prompt sanitization (`_pivot_revision_prompt.md`)

| Required check | Result |
| --- | --- |
| Literal FAIL_TO_PASS list absent | **PASS** — no `FAIL_TO_PASS:` header |
| Literal `test_unparse[()-()]` absent | **PASS** |
| Literal `test_parse_annotation` absent | **PASS** |
| Old string `matches FAIL_TO_PASS test` absent | **PASS** |
| "withheld benchmark test-expectation" wording present *if conflict context renders* | **N/A** — no rule-out conflict block rendered this run (the first pass left `sphinx/pycode/ast.py::unparse` as a plain *missing* candidate, not a conflicted rule-out), so the conflict-evidence path was not exercised. The test-expectation withholding note ("Benchmark/evaluator test labels are withheld under the fair verification policy", line 56) is present. |
| Repo-test discovery protocol present | **PASS** (lines 65–69) |
| "Do not guess from function name" present | **PASS** (line 63) |
| Canonical unpiped pytest instruction present | **PASS** (lines 71–77) |
| Anti-over-edit guardrails present | **PASS** (lines 50–52) |

**No prompt leak. M28.2's fix holds, and no FAIL_TO_PASS node id reaches the prompt by any
path.** The defensive `assertNoWithheldTestLabels` guard did not fire (the build succeeded).

---

## 4. Discovery chain

Source: `_pivot_revision_tool_calls.json` (9 ordered calls):
`[0] Read sphinx/pycode/ast.py`, `[1] Grep tests/`, `[2] Bash pytest …test_parse_annotation … 2>&1`,
`[3,4] python3 -c smoke checks`, `[5] Read sphinx/domains/python.py`, `[6,7] Edit python.py`,
`[8] git diff`.

| Step | Observed? | Command / tool | Evidence |
| --- | --- | --- | --- |
| repo-test search/list | **yes** | `Grep` over `…/tests` | Output: `tests/test_domain_py.py:239:def test_parse_annotation():` — a search ran and surfaced the test function definition. |
| test-file read / cat / sed | **no** | (only source reads: `ast.py`, `python.py`) | The agent never opened `tests/test_domain_py.py`. This is exactly the "grep-only evidence without reading the test file" the scaffold (line 78) tells it to avoid. |
| test command | **yes** | `python -m pytest tests/test_domain_py.py::test_parse_annotation -xvs 2>&1` | Errored on import (`parsedOutcome.status = error`; testing-fixtures traceback in the env). |
| canonical unpiped command | **no** | — | The only test command carried a `2>&1` redirect. |
| shell-piped / truncated command | **yes (redirect present)** | `… -xvs 2>&1` | Triggers `commandSafety.diagnosticOnly`. |

The selected node `test_parse_annotation` is itself a FAIL_TO_PASS for this instance, so the
provenance classifier records "selected test matches injected FAIL_TO_PASS/testExpectation".
The grep surfaced it, but a grep over `tests/` (pattern, not a path that names the file leaf)
plus **no test-file read** is not a credited search→read discovery chain — so the selection
cannot be distinguished from knowing the hidden label, and is classified `injected_metadata`.

---

## 5. Planner / verifier results

Planner: `--patch-source pivot_revision_revised --command-source pivot_revision_test_commands`.
Verifier run **without** `--allow-docker-verify`.

| Field | Value |
| --- | --- |
| `eligibleForFutureExecution` | **false** |
| provenance (`fairProvenance.classification`) | **injected_metadata** — evidence: "selected test matches injected FAIL_TO_PASS/testExpectation"; "prior output surfaced the selected test node" |
| `allowedForFairVerification` | **false** |
| `commandSafety` | `allowed:false`, `diagnosticOnly:true`, reason: `shell pipeline/redirect token ">" — not fair-executable as captured` (the `2>&1`) |
| `blockers` | (1) `provenance "injected_metadata" is not allowed for fair verification`; (2) `command not fair-executable as captured: shell pipeline/redirect token ">"` |
| `selectedTests` | `["tests/test_domain_py.py::test_parse_annotation"]` |
| `expectedImageKey` | `swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7462:latest` |
| `patchSha256` | `2ac93bfcd36a94aac620355dbae1f978a681f227e75d1d36f498279267eddb60` |
| Verifier status (no Docker) | **skipped — `plan_ineligible`** (Gate 1). `dockerStarted:false`, `commandExecuted:false`, `canonicalArtifactsUntouched:true` |

As in M28.1, the verifier skipped at Gate 1 (`plan_ineligible`) and never reached the Gate 4
`docker_not_authorized` skip.

---

## 6. Interpretation

- **Did sanitization hold?** Yes — the prompt carries no FAIL_TO_PASS list and no literal test
  node by any path. The M28.1 contamination is gone; this rerun is a clean measurement.
- **Did the stronger scaffold induce a *credited* discovery?** No. The agent did grep the test
  directory (and the grep output literally showed `def test_parse_annotation`), but it did
  **not read the test file** and went straight to running the node — precisely the two
  behaviours the scaffold explicitly warns against (lines 78–79). The provenance gate therefore
  does not credit a search→read chain.
- **Why `injected_metadata` (worse than M28.1's `ambiguous`)?** M28.1 selected a whole *file*
  (`tests/test_pycode_ast.py`), which did not exactly match a FAIL_TO_PASS node → `ambiguous`.
  M28.3 selected an exact *node* (`test_parse_annotation`) that **is** a FAIL_TO_PASS → the
  injected-metadata signal fires, and with no strong discovery chain it lands in the strictest
  bucket.
- **What is the binding blocker?** Provenance, not the redirect. Canonicalizing the command
  (stripping `2>&1`) would still leave `injected_metadata` → still ineligible. Conversely, even
  a perfect search→read chain caps this case at `ambiguous` (injected label + strong discovery
  → ambiguous), which is *still* disallowed (`allowedForFairVerification` requires
  `agent_discovered`). For this instance the genuinely-correct focused test **is** the
  evaluator's FAIL_TO_PASS, so the current policy may be structurally unable to ever rate it
  `agent_discovered` — a provenance-policy question beyond the prompt scaffold.

---

## 7. Next recommendation

**B — add a stronger explicit repo-test-search mini-step/scaffold.** The prompt is clean but
the run produced no *credited* search→read discovery chain: the agent grep-found the test and
ran it without ever reading the test file. A more forcing scaffold — require an explicit
test-file **read** (cat/open of the discovered test) and a canonical command before the agent
may claim a focused test — is the necessary next lever to move provenance off
`injected_metadata`.

Caveat to carry forward (not a substitute for B): because the only relevant focused test here
*is* the evaluator's FAIL_TO_PASS, a credited search→read chain would at best yield `ambiguous`,
which the planner still rejects. So after B, the provenance policy itself likely needs a
follow-up decision — whether `ambiguous`-with-strong-independent-discovery should be
fair-eligible, or how to handle the case where the correct test coincides with a hidden label.
No `--allow-docker-verify` is warranted (plan ineligible). No 30/100 sweep.

---

## Provenance & guardrails

- No Docker run; `--allow-docker-verify` never passed; verifier skipped before any container
  start (`canonicalArtifactsUntouched:true`).
- Report-only; **no source/benchmark code changed** in this validation.
- Raw run artifacts under `runs/<label>/raw/` left untracked (not staged).
