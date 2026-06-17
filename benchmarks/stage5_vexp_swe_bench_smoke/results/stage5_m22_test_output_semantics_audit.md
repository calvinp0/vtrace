# Stage 5 — M22 test-output semantics, provenance & patch-state audit

## 1. Executive conclusion

Captured agent-run test outputs are now **parseable into a reliable outcome** (the
pipeline-masked `success=true` is correctly overridden by output-text parsing), **but they
are NOT yet usable for fair revision adoption.** On the fresh M21.1 run, every captured
pytest:
- had `rawToolSuccess=true` yet a parsed outcome of **error** (a `Traceback`/`ImportError`)
  — proving raw success is untrustworthy and output parsing is necessary;
- selected a test whose name **exactly matches injected FAIL_TO_PASS metadata**
  (`injected_metadata` provenance) — so the *choice* of test is not provably the agent's own;
- ran in a state that **cannot verify the final patch** (`after_observed_edit_state` /
  `revision_phase_state`, `canVerifyFinalPatch=false`).

So: parsing ✅, fairness ❌. Two of the three M21.1 gaps (provenance, patch-state) remain
open and block adoption; the first (unreliable `success`) is now mitigated by parsing.

## 2. What changed (pure analyzers, no oracle)

Added to `src/capsule/toolOutputCapture.ts` (PURE; no fs/Docker/evaluator):
- `parsePytestOutcome(output, {truncated})` → `{framework, status, evidence, confidence}` with
  status ∈ passed/failed/error/failed_or_error/unknown. **Failure-biased**: any
  traceback/ERRORS/FAILURES/`N failed`/`N error` marker overrides a stray "passed" — a
  `| head`-masked exit cannot launder a failing run into a pass.
- `outcomeMismatch(rawToolSuccess, parsed)` → flags `rawToolSuccess=true` vs a failing parse.
- `classifyTestProvenance(...)` → agent_discovered / injected_metadata / ambiguous / unknown,
  from selectedTests vs injected FAIL_TO_PASS vs prior exploration commands.
- `classifyTestPatchState(...)` → pre_patch_state / after_observed_edit_state /
  revision_phase_state / unknown, with `canVerifyFinalPatch` that is **always false** (the
  in-loop stream never proves the working tree at test time equals the extracted patch).
- `TestCommandEvent` now also carries `parsedOutcome` (additive); raw `success`/`exitCode`
  preserved separately.

## 3. Outcome parsing table (label `eval-m21-capture-current-sphinx-7462-r1`)

| phase | command | raw success | exitCode | parsed status | confidence | evidence | mismatch? |
| ----- | ------- | ----------- | -------- | ------------- | ---------- | -------- | --------- |
| first_pass | `pytest tests/test_domain_py.py::test_parse_annotation -xvs 2>&1 \| head -50` | true | null | **error** | high | `Traceback (most recent call last)` | **yes** |
| pivot_revision | `pytest tests/test_pycode_ast.py::test_unparse -k "()" -x -v 2>&1 \| head -40` | true | null | **error** | high | `Traceback (most recent call last)` | **yes** |

Both are the masking signature: the `| head` pipeline returns 0, so `is_error=false`
(`success=true`), but the captured output is an `ImportError` (jinja2 `environmentfilter`
— an environment/plugin issue, so the test never actually executed). Output parsing flags
both as errors; `success` alone would have called them passes.

## 4. Provenance table

| phase | selected test | in injected metadata? | discovered by prior repo commands? | classification | notes |
| ----- | ------------- | --------------------- | ---------------------------------- | -------------- | ----- |
| first_pass | `tests/test_domain_py.py::test_parse_annotation` | yes (FAIL_TO_PASS) | no (prior calls: Read/Edit `python.py`, `git diff` — no grep/read of the test) | **injected_metadata** | name overlaps VTRACE-injected FAIL_TO_PASS / capsule "failing test" labels |
| pivot_revision | `tests/test_pycode_ast.py::test_unparse` | yes (FAIL_TO_PASS `test_unparse[()-()]`, leaf match) | no | **injected_metadata** | revision prompt injects FAIL_TO_PASS explicitly |

Injected FAIL_TO_PASS for this instance:
`tests/test_domain_py.py::test_parse_annotation`, `tests/test_pycode_ast.py::test_unparse[()-()]`.
Neither selected test was reached via the agent's own exploration, so we cannot claim a
deployed VTRACE (without FAIL_TO_PASS injection) would have run the same test.

## 5. Patch-state table

| phase | command | position in tool sequence | prior edit/write observed? | patchState old | patchState refined | can verify final patch? | notes |
| ----- | ------- | ------------------------- | -------------------------- | -------------- | ------------------ | ----------------------- | ----- |
| first_pass | pytest test_parse_annotation | idx 4 of 7 (after Read+2×Edit `python.py`) | yes | `first_pass_before_model_patch` | `after_observed_edit_state` | **no** | edits preceded the test, but the final modelPatch is extracted after the loop; the test also errored |
| pivot_revision | pytest test_unparse | within revision phase, before revised-patch extraction | yes | `revision_phase_before_revised_patch` | `revision_phase_state` | **no** | revised patch extracted after the loop |

No artifact proves any test ran against the installed final/revised patch, so
`canVerifyFinalPatch=false` everywhere. We do NOT assert `test_passed_final_patch`.

## 6. Fair adoption implications

**Can this captured test result adopt/reject a revised patch fairly today?** No. Even
ignoring that both runs errored on an environment import, (a) the test *selection* is
`injected_metadata` (oracle-adjacent — relies on VTRACE-injected FAIL_TO_PASS), and (b) no
test is tied to the final patch. A fair adoption signal needs a test that is both
agent-chosen (not from injected labels) AND demonstrably run against the patch being judged.

**What remains missing:**
1. An **allowed in-loop test policy** that defines which test runs count as fair (e.g. tests
   the agent selects from the problem statement / repo exploration, not injected
   FAIL_TO_PASS), and records that provenance explicitly.
2. **Patch-state binding**: an explicit post-final-edit verification step so a test can be
   tied to the applied patch (today the loop guarantees none).
3. A **clean environment** so pytest actually executes (this run errored on a jinja2
   ImportError before collecting), otherwise even a fair, well-bound test yields no signal.

## 7. Next recommendation

**B — add an explicit opt-in revision-pass test policy** that asks the agent to run a focused
test it selects (recording it as *allowed verification* with provenance), rather than
leaning on injected FAIL_TO_PASS. Parsing (this milestone) and patch-state refinement are in
place to interpret such a run honestly; the missing piece is a fair, agent-owned test
selection + a clean-enough environment to execute it. (Not recommending 30/100 yet.)

## 8. Scope / safety

- Pure analyzers + additive `parsedOutcome` field only. No live agents, no Docker, no
  30/100, no canonical replacement, revision pass still off by default.
- No retrieval/ranking/scoring/candidate/Capsule-v2-pivot changes; deterministic retrieval
  eval re-run byte-identical. Raw run artifacts not staged.
