# Stage 5 — M54: Corrective prompt/response variance audit

**Type:** offline audit, **report-only** (no code change). No live agents, no Docker, no SWE-bench evaluation, no diagnostic verifier.
**Subject:** the three M53 candidate-generation replicates of the M51/M52 rule-out corrective second pass on `sphinx-doc__sphinx-7462` (M53 commit `162c619`).
**Question:** why did the same corrective loop produce `candidate_ast_edit` (r1), `candidate_no_ast_edit` (r2), and `checker_did_not_fire` (r3)?

---

## 1. Executive verdict

- **Why did r1 edit `ast.py` while r2 did not?** **Pure model-judgment variance on byte-identical inputs.** r1 and r2 received the *same* first-pass patch (`1f5e48d6…`) and the *byte-identical* corrective prompt (`fc42beea…`). The only difference is the second-pass judgment: r1 stated the paired `ast.py` implementation returns `""` *instead of* `"()"` and judged that incorrect (the `()` notation is lost: `Tuple[()]` → `Tuple[]`), so it edited `ast.py`; r2 stated the same `""` output but rationalized it as "no crash, no incorrect output" and declined. The corrective prompt did **not** force r2 to test round-trip preservation, so its first-pass "empty string is safe" judgment survived unchallenged.
- **Why did r3 not fire?** **A rule-out *detection* recall gap, not a missing rule-out.** r3's 11-turn first pass *did* surface and grep-inspect `ast.py` and *did* emit a crash-shaped rule-out — *"the `sphinx/pycode/ast.py` version uses `", ".join(...)` which safely handles empty tuples. The issue is only in `sphinx/domains/python.py`."* But that phrasing contains **no `RULEOUT_CUE` lexical token** and r3 emitted **no `PIVOT_DECISION` marker**, so the checker's `ruleOutEvidence()` returned `undefined` and reported `missingEvidence: "rule-out text/decision for sphinx/pycode/ast.py::unparse"`. The rule-out was semantically present but lexically invisible to the detector.
- **Next step — prompt, trigger, or more reps?** **Sharpen the prompt (recommendation A).** The dominant, reproducible signal is r1/r2 judgment variance under identical inputs; the binding constraint is the corrective prompt's failure to force concrete output/round-trip reasoning. The r3 detection gap is real but secondary: fixing the trigger alone would only route r3 into the loop carrying the *same* "empty string is fine" judgment r2 held — likely yielding another `candidate_no_ast_edit`, not an `ast.py` edit. Fix the prompt first; address the detector-recall gap afterward (future M56), narrowly.

---

## 2. Run artifact matrix

| label | classification | checker fired? | 2nd call? | candidate? | ast.py edit? | first-pass sha | revised sha | prompt sha | response summary |
|---|---|---|---|---|---|---|---|---|---|
| …-r1 | `candidate_ast_edit` | yes | yes | yes | **yes** | `1f5e48d6` | `14e165a7` | `fc42beea` | stated `""` vs `"()"`; judged incorrect (`Tuple[()]`→`Tuple[]`); **edited both files** |
| …-r2 | `candidate_no_ast_edit` | yes | yes | yes | no | `1f5e48d6` | `1f5e48d6` | `fc42beea` | stated `""`; judged "correct output / no crash"; declined ast.py; **revised == first pass** |
| …-r3 | `checker_did_not_fire` | **no** | no | no | no | `6aca9946` | — | — | surfaced+grepped ast.py; crash-shaped rule-out present but **no `RULEOUT_CUE` token / no `PIVOT_DECISION`** → not detected |

Note: r1 and r2 first-pass patches are **byte-identical** (`1f5e48d6`); r2's revised patch SHA equals its first-pass SHA (the second pass reproduced the first patch verbatim).

---

## 3. r1 vs r2 deep comparison

Every input the corrective pass consumes was identical between r1 and r2; only the model's free judgment diverged.

| Question | Answer |
|---|---|
| First-pass patches identical? | **Yes** — both `1f5e48d6…`, both `python.py`-only |
| Checker JSON artifacts identical? | **No**, but only in the quoted `evidence[]` first-pass snippet. All *structured/decision* fields are identical: `triggered=true`, `triggerKind=cross_implementation_output_ruleout_insufficient`, `originalDecision=ruledOut`, `effectiveDecision=unclear`, `pairedOperation=unparse`, `editedImplementation=sphinx/domains/python.py::unparse`, `ruledOutImplementation=sphinx/pycode/ast.py::unparse` |
| Corrective prompts identical? | **Yes** — byte-identical (`fc42beea…`) |
| Prompt inputs identical except labels/timestamps? | **Yes** — the prompt is built purely from the structured checker fields (operation, edited impl, ruled-out impl), which matched. The prompt body contains **no run-specific tokens at all** (no label, no timestamp, no diff) |
| Same first-pass diff? | **Yes** — identical patch SHA |
| Corrective response reasoning differed? | **Yes** — see below |
| r2 explicitly said empty string acceptable? | **Yes** — *"returns `""` for an empty tuple … no crash, no incorrect output"*; *"correct output"* |
| r1 explicitly said empty string not acceptable? | **Yes** — *"produces `""` instead of `"()"` … it does lose the `()` notation — `Tuple[()]` becomes `Tuple[]` … both should preserve empty tuple syntax"* |
| Either cited repository evidence? | **No** — neither cited an existing test, call site, or documented behavior. The prompt's "concrete repository evidence" demand was honored by **neither** |
| Either ran or requested tests? | Both **attempted** ad-hoc tests; both hit the **same** unrelated Jinja2 import error; r1 then claimed a direct `ast.py`-module test passed, r2 tested "core logic"/AST. Neither ran the repository test suite (correct — oracle-free) |
| Each modified only ast.py / only python.py / both? | r1 = **both** (`python.py` + `ast.py`); r2 = **only `python.py`** |

**Conclusion:** the corrective loop is deterministic and fair up to the second model call; the outcome hinges entirely on whether the model, when asked "explain why the output is correct," tests round-trip preservation (`Tuple[()]` must re-render as `Tuple[()]`, not `Tuple[]`) or merely asserts that `""` "doesn't crash." r2 stated the concrete output yet still rationalized it — so "state the output" is necessary but not sufficient; the prompt must force the *comparison*.

---

## 4. r3 trigger analysis

| Question | Answer |
|---|---|
| Why did the checker not fire? | `ruleOutEvidence()` returned `undefined`: no `PIVOT_DECISION` marker, and no 7-line window around an `ast.py` mention matched `RULEOUT_CUE`. The checker therefore reported `missingEvidence: "rule-out text/decision for sphinx/pycode/ast.py::unparse"` and did not trigger. |
| Was ast.py surfaced in the original context? | **Yes** — `vtraceCapsulePivots` includes `sphinx/pycode/ast.py::unparse`; `vtracePivotCount=2` |
| Was ast.py read/mentioned? | **Yes** — 1 grep search (`isinstance(node, ast.Tuple)`) in `sphinx/pycode/ast.py`; 4 prose mentions in the first pass |
| Was there no PIVOT_DECISION? | **Correct** — enforcement was off; `parsePivotDecisionMarkers` found none |
| Was there no explicit rule-out? | A **semantic** rule-out was present (*"safely handles empty tuples. The issue is only in python.py"*); a **machine-detectable** rule-out was absent (no cue token, no marker) |
| Did the first-pass patch still edit only python.py? | **Yes** — `python.py`-only (`6aca9946`) |
| Would a broader trigger be fair, or over-trigger? | A **narrow** broadening is fair and oracle-free (uses only the agent's own prose + vtrace's own capsule surfacing + the agent's own patch). A **broad** "fire on any surfaced+unedited pivot even with no rule-out at all" expansion would over-trigger and is **not** justified by one data point. |

**Empirical confirmation.** Replaying the checker's exact window logic over r3's first-pass text: there are **2** windows mentioning `ast.py`, both containing the rule-out, and **0** of them match `RULEOUT_CUE`. The gating failure is precisely at the rule-out-identification step.

**Root cause — `RULEOUT_CUE` is narrower than `CRASH_CUES`.** The detector first needs a *rule-out* (`RULEOUT_CUE`: "ruled out", "no fix needed", "leave unchanged", "already handles", …) before it ever applies its richer crash-shaped classifier (`CRASH_CUES`, which *does* include a bare "safely"). A rule-out phrased as *"X safely handles the empty case; the issue is only in Y"* expresses a dismissal with crash-shaped reasoning but carries no `RULEOUT_CUE` keyword, so it is never recognized as a rule-out at all.

**r3 decision: B (narrow).** r3 exposes a rule-out **detection recall gap**, not a legitimate non-rule-out. The conservative fix is to extend `RULEOUT_CUE` to recognize crash-shaped dismissals that reference the surfaced paired implementation (e.g. "(safely|gracefully|naturally) handles empty …", "the issue/bug is only in …", "doesn't have the same issue"), **still requiring** an emitted rule-out tied to the paired pivot. This does **not** become generic "unedited pivot" enforcement.

---

## 5. Prompt weakness analysis

Current corrective prompt (verbatim, identical across r1/r2):

```
Your first-pass patch edited one implementation of `unparse` (sphinx/domains/python.py::unparse) but left a surfaced paired implementation unedited (sphinx/pycode/ast.py::unparse).

Your rule-out explains why the paired implementation may not crash, but it does not explain why its output or behavior is correct for the same edge case.

Either revise the patch or provide concrete repository evidence that the paired implementation preserves the intended behavior.
```

Assessment:

- It **does not** explicitly require the model to *state the concrete value* the paired implementation returns for the edge case.
- It **does not** require a *round-trip / preservation comparison* (does the returned value re-render the original source construct?).
- It only *implies* that "does not crash" is insufficient ("may not crash … but does not explain why its output … is correct"). r2 read this and still concluded `""` is "correct output" — so the implication is too weak to dislodge the prior judgment.
- Its "concrete repository evidence" demand was honored by **neither** run; both reasoned from first principles. The prompt asks for evidence it does not make mandatory or concrete.

**Verdict: the prompt is too weak.** It needs to force (1) a concrete output statement, (2) an explicit round-trip/preservation check, and (3) an explicit rejection of "does not crash / returns empty string safely" as sufficient.

---

## 6. Proposed prompt revision (for M55 — not implemented in this report-only milestone)

Oracle-free replacement block for `buildRuleOutCorrectivePrompt` (operation / editedImplementation / ruledOutImplementation are interpolated exactly as today):

```
Your first-pass patch edited one implementation of `{operation}` ({editedImplementation}) but left a surfaced paired implementation unedited ({ruledOutImplementation}).

Before ruling out the paired implementation, you must:
  1. State the concrete value or string the paired implementation returns for the SAME edge case your patch handled.
  2. State the source construct for that edge case, and whether re-rendering that returned value reproduces the original construct (i.e. the output round-trips / preserves it) — or whether information is lost.
  3. Justify why that output is behavior-preserving using concrete repository evidence (an existing test, a call site, or documented behavior).

Do NOT treat "does not crash", "is safe", or "returns an empty string" as sufficient evidence of correct output. If you cannot show the returned value preserves the intended behavior for the edge case, revise the patch so the paired implementation produces the correct output.
```

This keeps the existing safety guard (`assertRuleOutCorrectivePromptSafe`) green — it names only the operation and file paths (already present in today's prompt) and never states an expected output value, test id, or benchmark label.

---

## 7. Leakage audit

The proposed wording was scanned for every forbidden string. **None present:**

| Forbidden | In proposed prompt? |
|---|---|
| gold patch / gold patches | no |
| hidden test(s) | no |
| FAIL_TO_PASS | no |
| PASS_TO_PASS | no |
| `test_unparse[()-()]` | no |
| benchmark expected output | no |
| resolved status | no |

The proposal references the operation name (`unparse`) and the two paired file paths only — exactly the level of detail in today's prompt, which already passes `assertRuleOutCorrectivePromptSafe`. No oracle (no expected `"()"` value) is mentioned. It instructs the model to *derive* the correct output from repository evidence, not to be told it.

---

## 8. Recommendation

**A — M55: implement a sharper corrective prompt requiring a concrete output statement (and round-trip/preservation check), then run a 3-rep candidate-generation validation.**

Rationale:
- The decisive, *reproducible* finding is r1/r2 judgment variance on **byte-identical** inputs (same first-pass patch, byte-identical prompt). The binding constraint is the prompt, which lets the "empty string is safe" judgment survive. §6 targets exactly that and stays oracle-free (§7).
- The r3 finding (rule-out detection recall gap) is genuine but **secondary**: fixing the trigger alone would route r3 into the loop carrying the *same* judgment r2 held, most likely producing another `candidate_no_ast_edit` — no gain in the `ast.py` edit rate. It is documented here as a **future M56**, deliberately narrow (extend `RULEOUT_CUE`, not generic unedited-pivot enforcement), to be done **after** the prompt is sharpened.
- This matches the expected path and keeps every guard intact: still candidate-only, no auto-adoption, no Docker/eval/verifier, no oracle inputs.

Not chosen: **B** (trigger coverage) is real but lower-leverage and premature before the prompt is fixed; **C** (more reps, no change) would re-measure a variance we already explained; **D** (stop) is unwarranted — the loop is safe and partially working; **E** (return to broader work) is premature given a concrete, cheap prompt improvement is in hand.

---

## Appendix — evidence provenance

All findings derive from captured M53 artifacts under `…/runs/eval-m53-ruleout-corrective-sphinx-7462-{r1,r2,r3}/raw/vtrace/`: `_ruleout_sufficiency_check.json`, `_ruleout_sufficiency_corrective_prompt.md`, `_ruleout_sufficiency_corrective_response.txt`, `_ruleout_sufficiency_revised.patch`, `_ruleout_sufficiency_corrective_result.json`, `_run.meta.json`, `_tool_calls.json`, `_agent_stream.first_pass.jsonl`, and the canonical `swebench-*.jsonl` (`modelPatch`). Detector behavior was confirmed against `src/capsuleV2/ruleoutSufficiency.ts` (`RULEOUT_CUE`, `CRASH_CUES`, `ruleOutEvidence`, `textWindowsForPath`). No artifact was mutated; no live agent, Docker, evaluation, or verifier was run.
