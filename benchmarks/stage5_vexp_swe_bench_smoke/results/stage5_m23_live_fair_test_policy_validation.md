# Stage 5 — M23.1 live validation of the fair revision test policy

Run label: `eval-m23-fair-test-policy-current-sphinx-7462-r1` · instance
`sphinx-doc__sphinx-7462` · flag `--revision-verification-policy agent-discovered-tests`
(accepted spelling; alias `agent-discovered` also accepted). One run, no r2 needed. No Docker.

## 1. Executive verdict

**The opt-in policy produced a demonstrably fairer prompt and usable provenance telemetry.**
The revision prompt withheld every literal FAIL_TO_PASS name, rendered the agent-discovered
discovery instruction, and kept the anti-over-edit/minimal-diff guardrails and the M16 missing-
pivot context — all without exposing oracle test names. The full test-command capture path was
exercised end-to-end: a revision-phase pytest call was captured with bounded output, parsed to
an outcome, classified for provenance + patch-state, and rolled up into
`_revision_verification_policy.json`.

The honest negative: **fair prompting alone did not induce fair discovery, and the environment
blocked every test from executing.** The agent ran the oracle-matching test
`tests/test_domain_py.py::test_parse_annotation` *without any test-file discovery telemetry*
(no grep/find of test files), so provenance is conservatively `injected_metadata`
(`allowedForFairVerification=false`); and both first-pass and revision pytest runs **errored on
an import** before collecting a single test. So `fairVerificationUsable=false`, as expected for
M23 scaffolding. No adoption/canonical-replacement claim was made.

## 2. Run validity

| property | value |
| -------- | ----- |
| label | `eval-m23-fair-test-policy-current-sphinx-7462-r1` |
| valid? | **valid** — revision phase ran, a test command was produced, capture path exercised |
| revision pass ran? | yes (`_pivot_revision.json` → `ran=true`, `decisionReason="1 missing/unclear candidate(s)"`) |
| Docker run? | no (not needed for prompt-fairness / provenance / capture) |
| adoption? | none — `canonicalReplaced=false`, `replacementRecommended=false`, `revisionCandidate=false`, `replacementReason="not_verified"` |
| r2 needed? | no |

## 3. Prompt fairness

Inspecting `_pivot_revision_prompt.md`:

- **No literal FAIL_TO_PASS list** — the `FAIL_TO_PASS:` + names block is absent. Instead:
  *"Benchmark/evaluator test labels are withheld under the fair verification policy."*
- **No `test_parse_annotation`** and **no `test_unparse[()-()]`** anywhere in the prompt
  (grep: 0 matches for either literal).
- **Fair verification discovery instruction present** (`## Fair verification (agent-discovered
  focused test)` with the full discover/justify/report-env-failure/no-unverified-claim block).
- **Anti-over-edit/minimal-diff guardrails present** ("Do not edit a file merely because it is
  listed", "Prefer the minimal final diff", "Preserve already-correct changes", full
  `Rules:` block).
- **M16 / missing-pivot context renders without leaking names**: the outstanding candidate
  `sphinx/pycode/ast.py::unparse` is shown with a source excerpt and "inspect or rule out"
  framing — no oracle test name is used as a verification candidate.
- **One cosmetic residue (not a leak):** the static `Task:` line still reads "Use the
  FAIL_TO_PASS/test expectation and source excerpts above…" — the *token* "FAIL_TO_PASS"
  appears once (line 91) as a generic instruction word, but **no test name** accompanies it.
  Worth a one-line wording cleanup later; it does not expose any label.

Where each oracle test name came from: **neither leaked via prompt injection.**
`test_parse_annotation` appears only in **tool-call commands** (the agent's own pytest
invocations); `test_unparse[()-()]` does not appear anywhere in the run.

## 4. Artifact table

| artifact | exists? | phase | contains outputs? | contains provenance? | notes |
| -------- | ------- | ----- | ----------------- | -------------------- | ----- |
| `_agent_stream.first_pass.jsonl` | yes | first_pass | yes (raw stream) | n/a | 214 KB |
| `_tool_calls_with_outputs.json` | yes | first_pass | yes | no | enriched first-pass calls |
| `_test_commands.json` | yes | first_pass | yes (parsed) | no | 1 pytest, parsed `error` |
| `_agent_stream.pivot_revision.jsonl` | yes | pivot_revision | yes (raw stream) | n/a | 193 KB |
| `_pivot_revision_tool_calls.json` | yes | pivot_revision | yes (7/7 calls w/ output) | no | all phase=pivot_revision |
| `_pivot_revision_test_commands.json` | yes | pivot_revision | yes (parsed) | no | 1 pytest, parsed `error` |
| `_pivot_revision_prompt.md` | yes | pivot_revision | n/a | n/a | **fair** (no leaked names) |
| `_pivot_revision_response.txt` | yes | pivot_revision | n/a | n/a | rule-out + env-failure reported |
| `_pivot_revision.json` | yes | pivot_revision | n/a | n/a | no adoption (`canonicalReplaced=false`) |
| `_revision_verification_policy.json` | yes | pivot_revision | yes | **yes** | `policy=agent_discovered`, 1 row, `fairVerificationUsable=false` |

`_revision_verification_policy.json` → `policy="agent_discovered"` (internal value of the
`agent-discovered-tests` CLI token). `canonicalReplaced=false` and `replacementRecommended=false`
confirmed independently in `_pivot_revision.json`.

## 5. Test command table

| phase | command | selectedTests | parsedOutcome | rawToolSuccess | outcomeMismatch | provenance | allowed? | patchState | canVerifyFinal | usable | blockers |
| ----- | ------- | ------------- | ------------- | -------------- | --------------- | ---------- | -------- | ---------- | -------------- | ------ | -------- |
| first_pass | `pytest tests/test_domain_py.py::test_parse_annotation -xvs 2>&1 \| head -80` | `test_parse_annotation` | **error** (Traceback) | true | **true** | (not classified in first_pass artifact) | — | first_pass_before_model_patch | false | — | — |
| pivot_revision | `pytest tests/test_domain_py.py::test_parse_annotation -xvs 2>&1 \| head -50` | `test_parse_annotation` | **error** (Traceback) | true | **true** | **injected_metadata** | **false** | revision_phase_state | **false** | **false** | provenance not allowed · outcome not "passed" · patch-state can't verify final · env/import markers (Traceback) |

`outcomeMismatch=true` on both: the `\| head` pipeline returns 0 so `is_error=false`
(`rawToolSuccess=true`), but the captured output is an import `Traceback` — the M21.1/M22
pipeline-masking signature, correctly overridden by output-text parsing.

## 6. Interpretation

**Did the agent discover tests without injected labels?** No — not provably. The revision-phase
tool sequence was: `Grep` on `sphinx/pycode/ast.py` (source, not tests) → `python -c` repro →
`pytest …::test_parse_annotation` → Read/Edit `python.py` → `git diff`. The agent never grepped
or listed **test files**; it ran the test whose name is the obvious counterpart of the function
it edited (`_parse_annotation` → `test_parse_annotation`), which also coincides exactly with the
injected FAIL_TO_PASS. With no test-file discovery in `priorCommandText`, the classifier
conservatively returns `injected_metadata` / `allowed=false` rather than crediting discovery.
This is the correct, non-overclaiming call — the sanitized prompt removed the *label*, but the
agent's behavior still cannot be *proven* oracle-independent.

**Are parsed outputs reliable?** Yes. Raw tool success was masked to `true` by `| head`, but
output parsing flagged both runs as `error` from the import `Traceback`, and `outcomeMismatch`
caught the disagreement. Capture, bounding, parsing, and the env-marker detector all worked on
real data.

**What still blocks fair adoption?** Two stacked blockers: (1) **the environment** — both passes
errored importing the pytest plugin chain (`sphinx.testing.fixtures` → … → a jinja2 version
mismatch), so **no test executed**, yielding zero pass/fail signal; (2) **provenance** — even had
it run, the chosen test is `injected_metadata`, and (3) **patch-state** — the in-loop run still
can't be tied to the final/revised patch (`canVerifyFinalPatch=false`). All three are reflected
honestly in `fairVerificationBlockers`.

## 7. Next recommendation

**E — environment blocks all tests: keep environment-failure classification/reporting only; do
not use tests for adoption yet.** Both passes errored on import before collecting any test, so
no fair signal is obtainable from this instance regardless of prompt fairness or provenance. The
M23 classifier already surfaces the env failure as an explicit blocker (working as intended); the
prerequisite to any future test-based fairness signal is a clean, isolated test environment that
actually runs pytest.

Immediate follow-on (once the environment runs tests): **B — strengthen the discovery instruction
or add a repo-test-search scaffold**, since fair prompting alone did not induce the agent to
*discover* a test (it ran the oracle-matching name without exploring test files), which is what
keeps provenance at `injected_metadata`. Do **not** run 30/100.

## 8. Scope / safety

Report-only validation of one pre-approved live case. No retrieval/ranking/scoring/candidate or
Capsule-v2-pivot changes. No revised patch wired into canonical evaluation; revision pass and
policy remain off by default. Raw run artifacts under `runs/` not staged.
