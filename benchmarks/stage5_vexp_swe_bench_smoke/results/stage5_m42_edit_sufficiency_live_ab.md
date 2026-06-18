# Stage 5 — M42: Edit-Sufficiency Checklist live A/B (sphinx-doc__sphinx-7462)

**Date:** 2026-06-18
**Instance:** `sphinx-doc__sphinx-7462` (only)
**Feature under test:** M41 end-of-context **edit-sufficiency checklist**
(`VTRACE_ENABLE_EDIT_SUFFICIENCY_CHECKLIST`) layered on top of the M39 **semantic edit
hypothesis** (`VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS`). Both rendering-only, default-off.
**Hypothesis being tested:** moving the semantic co-edit warning to the *end-of-context decision
point* (a non-enforcing checklist) — the M40 recommendation B — converts inspection into the missing
`sphinx/pycode/ast.py::unparse` edit.
**Design:** 3 replicates per arm = 6 `run-protocol` runs, arms interleaved
(c-r1, t-r1, c-r2, t-r2, c-r3, t-r3) so any temporal/API drift is balanced across arms.
**Protocol (both arms):** `vtrace-indexed --capsule-intent auto --capture-product-v2-accounting --disable-pivot-check`.
**Only knobs varied (together):** `VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS` + `VTRACE_ENABLE_EDIT_SUFFICIENCY_CHECKLIST`
(control = both `0`, treatment = both `1`).
**Not enabled:** pivot-revision-pass, pivot-inspection-enforcement, agent-discovered-tests verification,
the diagnostic verifier (`--allow-docker-verify`), any other experimental toggle.
**Canonical evaluation:** `--mode evaluate --eval-mode docker` on the 6 M42 labels (canonical SWE-bench
resolution; NOT the diagnostic verifier).

> Scope caveat: single-instance behavioral probe (n=3/arm). It tests *mechanism* on the instance M39/M41
> were designed around — not general product performance. Do not over-generalize.

---

## 1. Executive verdict

- **Did the end-of-context checklist change the edit decision? NO.** All 6 runs (control and treatment)
  edited **only `sphinx/domains/python.py`**. `ast.py::unparse` edit rate is **0/3 in both arms.**
- **Did it improve resolution? NO.** Canonical Docker resolution is **0/3 in both arms.** Gold requires
  editing **both** `python.py` **and** `sphinx/pycode/ast.py`, and FAIL_TO_PASS includes
  `tests/test_pycode_ast.py::test_unparse[()-()]`. Resolution needs *all* FAIL_TO_PASS, so a
  `python.py`-only patch **cannot resolve this instance** — and no run produced the ast.py edit.
- **Did it increase token/tool/cost burden? Only the deterministic injected text; no run-time regression.**
  Treatment adds a bounded **+298-token** injected payload (semantic hypothesis 114 + checklist 183;
  median injected context 2890 → 3188 tokens). On the agentic side treatment was, if anything, *cheaper*
  this batch (median tool calls 8 → 6, median cost \$0.374 → \$0.285, median turns 24 → 18) — control drew
  the noisier/more-expensive draws. No tool/cost/turn regression.
- **What DID change (reasoning):** the checklist reliably moved the rule-out framing from
  *"no `pop()`, doesn't crash"* (control) to an explicit **output-correctness judgment** of `ast.py`
  (treatment) — in all 3 treatment runs the agent completed the co-edit checklist and asked whether the
  empty-tuple *output* is correct. **But it answered the question wrong every time:** it judged
  `", ".join([]) == ""` to be the *correct* rendering of an empty tuple and ruled `ast.py` out — when gold
  requires the empty tuple to render as `"()"`. The checklist made the agent ask the right question and
  supply the wrong ground truth.

**Mechanism:** control = `control_baseline_gap` (×3); treatment = `checklist_seen_but_no_edit` (×3).
No `checklist_action_success`, no `regression`, no `inconclusive`.

**Recommendation: C** — treatment changes reasoning/inspection but still does not edit `ast.py`. Per the
pre-registered decision rule (ast.py edit rate 0/3 in treatment ⇒ C or D), and because there *was* a
behavioral effect (the reasoning reframe), this is **C, not D**: stop first-pass *text-prompt* approaches
for sphinx and return to the gated revision/enforcement branch. **Do not propose another, stronger
first-pass text prompt.**

---

## 2. Run matrix

All 6 runs valid (`vtraceContextInjected=true`, exit 0, patch produced). All canonical evals ran (Docker,
`evaluationRan=true`, `resolvedCount=0` for all 6).

| label | arm | rep | valid | patch | hyp rendered | hyp tok | checklist rendered | checklist tok | ast surfaced | ast inspected | ast mentioned | ast.py edited | python.py edited | resolved |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| eval-m42-control-sphinx-7462-r1 | control | 1 | ✓ | ✓ | — | 0 | — | 0 | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m42-control-sphinx-7462-r2 | control | 2 | ✓ | ✓ | — | 0 | — | 0 | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m42-control-sphinx-7462-r3 | control | 3 | ✓ | ✓ | — | 0 | — | 0 | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m42-treatment-sphinx-7462-r1 | treatment | 1 | ✓ | ✓ | ✓ | 114 | ✓ | 183 | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m42-treatment-sphinx-7462-r2 | treatment | 2 | ✓ | ✓ | ✓ | 114 | ✓ | 183 | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m42-treatment-sphinx-7462-r3 | treatment | 3 | ✓ | ✓ | ✓ | 114 | ✓ | 183 | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |

Per-run tool/token/cost detail:

| label | tool calls | Read | Grep/Search | Bash | unique files edited | input tokens (uncached) | injected ctx tokens | cost (USD) | turns |
|---|---|---|---|---|---|---|---|---|---|
| control-r1 | 8 | 2 | 0 | 4 | 1 | 174 | 2890 | 0.4389 | 24 |
| control-r2 | 9 | 3 | 1 | 3 | 1 | 202 | 2890 | 0.3742 | 28 |
| control-r3 | 6 | 1 | 1 | 2 | 1 | 132 | 2890 | 0.2303 | 18 |
| treatment-r1 | 5 | 2 | 1 | 0 | 1 | 111 | 3188 | 0.3449 | 15 |
| treatment-r2 | 6 | 2 | 1 | 1 | 1 | 132 | 3188 | 0.2404 | 18 |
| treatment-r3 | 8 | 4 | 0 | 2 | 1 | 167 | 3188 | 0.2850 | 23 |

> **Injected-context token note.** `injected ctx tokens` is the size of the full rendered context the
> agent receives (`_capsule_v2_context.md` chars ÷ 4), which includes the end-of-context checklist. The
> `vtraceContextChars` telemetry field reports treatment as 3007 (= control + the 114-token *hypothesis*
> only) because it is stamped *before* the checklist is appended near the end of context; it therefore
> **undercounts** treatment by the 183-token checklist. The honest deterministic delta is
> **+298 tokens** (2890 → 3188), matching the M41 offline estimate (~298). `input tokens` is the uncached
> prompt portion only (prompt caching active); it and turn count are agent-loop noise — cost is the better
> burden proxy.

---

## 3. Mechanism analysis — focus on `sphinx/pycode/ast.py::unparse`

Gold-patch ground truth (from `swe-bench-100.jsonl`):

- Gold edits **`sphinx/domains/python.py`** (guard `result.pop()` for empty `ast.Tuple`/`ast.List`) **and**
  **`sphinx/pycode/ast.py`** (`unparse` of an empty `ast.Tuple` must return `"()"`, not `", ".join([]) == ""`).
- FAIL_TO_PASS = `tests/test_domain_py.py::test_parse_annotation`, `tests/test_pycode_ast.py::test_unparse[()-()]`.
- The `ast.py` test asserts an empty tuple renders as `"()"` — **exactly** the "empty container must render
  correctly, not just avoid crashing" failure the hypothesis/checklist are designed to flag.

Per-run mechanism:

- **Control (×3) → `control_baseline_gap`.** `ast.py::unparse` is surfaced (secondary pivot) and the agent
  inspects it in every run (3/3 this batch, up from 2/3 in M40), but rules it out on crash-avoidance grounds
  and edits only `python.py`. Reproduces the known python.py-only behavior.
- **Treatment (×3) → `checklist_seen_but_no_edit`.** Hypothesis (114 tok) + checklist (183 tok) render in
  every run. The agent grep/read-inspects `ast.py::unparse` (3/3), explicitly **works the checklist**
  ("Co-edit checklist completed: … Inspected `sphinx/pycode/ast.py::unparse` → ruled out"), and discusses
  the empty-tuple output — but **never edits it.** No run reached `checklist_action_success`.

The checklist moved the agent through surfaced → inspected → mentioned → *explicit output-correctness
deliberation*, but failed to flip the terminal step (**edit**) — because the agent's output-correctness
deliberation itself reached the wrong answer (see §5).

---

## 4. Aggregate A/B table

| metric | control (n=3) | treatment (n=3) | delta |
|---|---|---|---|
| `ast.py` edit rate | **0% (0/3)** | **0% (0/3)** | 0 |
| `ast.py` inspection rate (read/grep) | 100% (3/3) | 100% (3/3) | 0 |
| `ast.py` mention / rule-out rate (reasoning) | 100% (3/3) | 100% (3/3) | 0 |
| canonical resolved rate | **0% (0/3)** | **0% (0/3)** | 0 |
| median tool calls | 8 | 6 | −2 (noise; treatment cheaper this batch) |
| median input tokens (uncached) | 174 | 132 | −42 (noise) |
| median injected-context tokens | 2890 | 3188 | **+298** (deterministic: hyp 114 + checklist 183) |
| median cost (USD) | 0.3742 | 0.2850 | −0.089 (noise; control drew the expensive runs) |

The only deterministic movement is the **+298-token injected payload**. Edit rate, inspection rate, mention
rate, and resolved rate are flat (0 / 100% / 100% / 0). Tool/cost/turn deltas are inside per-run noise and
happen to favor treatment this batch — there is **no burden regression**.

---

## 5. Reasoning analysis — did treatment change the wrong rule-out?

Target faulty inference (from M38/M40):

```
from:  ", ".join([]) does not crash, so ast.py::unparse needs no edit
to:    an empty tuple must RENDER as "()", so ast.py::unparse needs an edit
```

**Control** — pure crash-avoidance rule-out, every rep. The agent frames `ast.py` purely by mechanism
("no `pop()` calls"), never asking what the output *should* be:

- r1: *"it handles tuples differently by just joining elements, so empty tuples return an empty string
  without any pop operations … ruled out since it uses `", ".join()` which safely handles empty lists."*
- r2: *"`sphinx/pycode/ast.py::unparse` handles empty tuples/lists correctly by returning empty strings."*
- r3: *"This correctly returns an empty string `""` for an empty tuple, so no fix is needed there."*

**Treatment** — the checklist *did* flip the framing from "no crash" to "is the output correct?", in all 3
reps the agent explicitly performs the output-correctness step and even records a completed checklist:

- r1: *"For empty `ast.Tuple`: returns `""` (empty string, which is correct for an empty tuple's contents) …
  **No crash and correct output.**"* and the final answer carries *"Co-edit checklist completed: … Inspected
  `sphinx/pycode/ast.py::unparse` → ruled out (uses `join()` which handles empty iterables correctly)."*
- r2: *"This returns an empty string for empty tuples, **which is correct** … So no fix is needed in
  `sphinx/pycode/ast.py`."*
- r3: *"This correctly returns an empty string `""` for an empty tuple, so no fix is needed there."*

**Conclusion — the reframe happened, but the answer is wrong.** Unlike M40 (where only 1/3 reps reached
*partial* output-correctness reasoning), **all 3 M42 treatment runs explicitly evaluated output correctness**
of `ast.py::unparse`. That is the behavioral change the checklist was built to produce. But the agent then
**asserted `""` is the correct rendering of an empty tuple** and ruled the edit out — exactly inverting the
ground truth (gold: empty tuple → `"()"`; the FAIL_TO_PASS `test_unparse[()-()]` encodes this). The checklist
gets the agent to *ask the right question at the decision point* but cannot supply the missing fact that an
empty tuple must render as `"()"`. So the rule-out moved from "doesn't crash ⇒ fine" to "output is (wrongly
judged) correct ⇒ fine" — a deeper but still-incorrect rule-out, never converted into the `ast.py` edit.

---

## 6. Failure / regression analysis

- **No resolution regression and no resolution gain:** 0/3 both arms. Structurally unresolvable without the
  `ast.py` edit (FAIL_TO_PASS gate), and no run produced it.
- **No tool/cost/turn regression:** medians favor treatment this batch (tool calls 8→6, cost \$0.374→\$0.285,
  turns 24→18); the variation is run-to-run agent-loop noise (control happened to draw the longest runs).
  The only deterministic cost is the bounded **+298-token** injected payload.
- **No invalid/inconclusive runs:** all 6 valid, all evals ran.
- **Knob fidelity:** hypothesis + checklist rendered in all 3 treatment runs (114 + 183 tok) and in zero
  control runs — rendering-only, default-off, behaved exactly as designed.
- **New failure characterization:** the failure is no longer "agent didn't consider output correctness"
  (M40) but "agent considered output correctness **and concluded wrongly**". A stronger *text* prompt cannot
  fix this — the gap is a missing ground-truth fact (`Tuple[()]` ⇒ `"()"`), which only a test-grounded or
  verification-grounded signal supplies.

---

## 7. Final recommendation for this branch

**C. Treatment changes reasoning/inspection but still does not edit `ast.py` → stop first-pass text-prompt
approaches for sphinx and return to the gated revision/enforcement branch.**

Rationale:

- The pre-registered rule is explicit: **ast.py edit rate 0/3 in treatment ⇒ C or D, and do not propose
  another stronger first-pass text prompt.** Edit rate is 0/3, so the rule binds.
- C over D because there *was* a behavioral effect: the checklist reliably converted the rule-out from pure
  crash-avoidance into an explicit output-correctness deliberation in all 3 treatment runs (D = "no
  behavioral effect" does not fit).
- The M42 result sharpens M40's: the end-of-context placement *succeeds* at getting the agent to ask the
  right question at the decision point, and *still fails* because the agent answers it wrong. The residual
  gap is a **ground-truth fact** ("empty tuple must render `"()"`") that no advisory text can inject reliably
  — it requires a signal the agent can be *wrong against*: the failing `test_unparse[()-()]`. That is the
  province of the gated **revision/enforcement/verification** branch (M12 enforcement + M14/M15 revision with
  a verification policy), not a richer first-pass prompt.

This is **not** A (no edit, no pass-rate gain), **not** B (treatment did not edit ast.py, so there is no
synthesis failure to audit), **not** D (there *was* a reasoning effect), and **not** E (no cost/resolution
harm; the +298-token payload is bounded and there is no run-time regression).

**Action:** keep `VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS` and `VTRACE_ENABLE_EDIT_SUFFICIENCY_CHECKLIST`
default-off (do not productize), close the first-pass-text line of attack for sphinx-7462, and resume the
gated revision/enforcement branch where a verification signal can ground the empty-tuple fact.

---

## Appendix — provenance & guardrails

- Source code **unchanged** this milestone — M42 is benchmark + analysis only. (No retrieval / ranking /
  scoring / candidate-generation touched; deterministic retrieval no-change proof therefore N/A.)
- Revision pass, pivot-inspection enforcement, agent-discovered-tests verification, and the diagnostic
  verifier (`--allow-docker-verify`) were all **avoided**.
- Canonical evaluation only: `--mode evaluate --eval-mode docker` on the 6 M42 labels (`resolvedCount=0` ×6).
- Structured outputs: `stage5_m42_edit_sufficiency_live_ab.csv`, `stage5_m42_edit_sufficiency_live_ab.json`.
- Raw run artifacts under `results/runs/eval-m42-*/` are untracked and not staged.
