# Stage 5 — M21.1 live test-output capture validation

## 1. Executive verdict

**M21 capture works on a fresh live run.** A single revision-enabled `sphinx-doc__sphinx-7462`
run produced all six additive per-phase artifacts, captured the agent's Bash command
**outputs** (incl. its `pytest` runs) with correct bounds and phase tags, classified the
test commands, and kept first-pass and revision-phase telemetry fully separated. No Docker /
shadow eval was used, so every captured signal is generated inside the agent loop.

One honest caveat surfaced: the boolean `success` (derived from the stream's `is_error`) is
**unreliable when the agent pipes the test through `| head`** — the pipeline's exit code
masks pytest's, so `success=true` even though the captured *output* shows a failing/erroring
run. The captured **output text** is the trustworthy signal; the `success` boolean is not.

## 2. Run validity

| field | value |
| ----- | ----- |
| label | `eval-m21-capture-current-sphinx-7462-r1` |
| instance | `sphinx-doc__sphinx-7462` |
| run-protocol | succeeded (exit 0, 1/1 patched, ~$0.49) |
| first-pass model patch | present (24 lines), `resolved=None` (no Docker — intended) |
| revision phase | ran (`ran=true`, revised patch non-empty) |
| adoption record | `revisionCandidate=true`, `replacementRecommended=false` (`not_verified`), `canonicalReplaced=false` |
| Docker eval | not run (no `_eval.meta.json`) — this task is about capture, not resolution |

Only r1 was run (valid; the agent ran test commands), so r2 was not needed.

## 3. Artifact table

| artifact | exists? | phase | contains commands? | contains outputs? | contains test commands? | notes |
| -------- | ------- | ----- | ------------------ | ----------------- | ----------------------- | ----- |
| `_agent_stream.first_pass.jsonl` | yes (205 KB) | first_pass | raw stream | raw stream | — | stable per-label copy |
| `_tool_calls_with_outputs.json` | yes | first_pass | yes (4 Bash) | yes (7/7 calls have output) | — | bounded; 0 truncated this run |
| `_test_commands.json` | yes | first_pass | — | outputSummary present | yes (1 pytest) | selectedTests = `tests/test_domain_py.py::test_parse_annotation` |
| `_agent_stream.pivot_revision.jsonl` | yes (213 KB) | pivot_revision | raw stream | raw stream | — | stable per-label copy |
| `_pivot_revision_tool_calls.json` | yes | pivot_revision | yes (5 Bash) | yes (5/5 Bash have output) | — | 10 calls, all `phase=pivot_revision` |
| `_pivot_revision_test_commands.json` | yes | pivot_revision | — | outputSummary present | yes (1 pytest) | selectedTests = `tests/test_pycode_ast.py::test_unparse` |

Separation verified: the first-pass file contains only `first_pass` phases; the revision
file contains only `pivot_revision` phases. `_tool_calls.json` (legacy) is unchanged.

## 4. Test command analysis

**First pass**
- command: `python -m pytest tests/test_domain_py.py::test_parse_annotation -xvs 2>&1 | head -50`
- framework: `pytest`; selectedTests: `["tests/test_domain_py.py::test_parse_annotation"]` (the exact FAIL_TO_PASS node id)
- output present: yes (1088–3524 byte outputs across Bash calls; this pytest output captured)
- outputSummary present: yes (shows a pytest import/collection Traceback)
- exit/success: `exitCode=null` (stream exposes none); `success=true` BUT unreliable — the `| head` pipeline masked the real pytest exit (output text contradicts the boolean)
- patchState: `first_pass_before_model_patch` (conservative — not overstated)
- signal classification: **command/output generation = fair_non_oracle**; **test-name selection = ambiguous** (the `test_parse_annotation` name is also surfaced by the injected capsule context / revision FAIL_TO_PASS, so the choice of which test to run may rely on injected metadata)

**Revision phase**
- command: `python -m pytest tests/test_pycode_ast.py::test_unparse -k "()" -x -v 2>&1 | head…`
- framework: `pytest`; selectedTests: `["tests/test_pycode_ast.py::test_unparse"]`
- output present: yes; outputSummary present: yes
- exit/success: `exitCode=null`, `success=true` (same `| head` caveat applies)
- patchState: `revision_phase_before_revised_patch` (conservative)
- signal classification: same as first pass (generation fair_non_oracle; selection ambiguous)

No Docker/shadow-eval was used anywhere in this run, so nothing here is oracle_assisted.

## 5. Fair-adoption implication

**Can future runs now provide the raw material for non-oracle adoption analysis?** Yes. Each
phase now persists, per label, the agent's own test command, its bounded output, and a
conservative patch-state — without any SWE-bench evaluator. This is the fair_non_oracle raw
signal M20 said was missing.

**What remains missing before adoption can be implemented?**
1. **Reliable outcome extraction.** `success` from `is_error` is defeated by `| head`
   pipelines; an adoption signal must parse pass/fail from the captured output text (e.g.
   pytest summary line) rather than the pipeline exit code.
2. **Test-name provenance/fairness.** The selected test names overlap with injected
   FAIL_TO_PASS / capsule "failing test" metadata, so the *selection* is currently
   ambiguous. Adoption must establish that a deployed VTRACE would have the same test signal
   without evaluator leakage.
3. **Patch-state strengthening.** Today tests are only ever `*_before_*_patch`; proving a
   test ran against the FINAL patch would need explicit post-edit verification, which the
   current loop does not guarantee.

## 6. Next recommendation

**A — capture works: audit test-name provenance/fairness and patch-state semantics (and add
robust output-based outcome parsing) before using test results for adoption.** The capture
path is validated; the open work is interpreting the captured signal fairly, not capturing
more. (Not recommending 30/100 yet.)

## 7. Scope / safety

- One approved live run; no Docker, no 30/100, no canonical replacement, revision pass still
  off by default. No retrieval/ranking/scoring/candidate changes.
- Raw run artifacts under `runs/` are NOT staged; this report is the only tracked output.
