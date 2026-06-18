# Stage 5 — M40: Semantic Edit Hypothesis live A/B (sphinx-doc__sphinx-7462)

**Date:** 2026-06-18
**Instance:** `sphinx-doc__sphinx-7462` (only)
**Feature under test:** M39 semantic edit hypothesis (`VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS`), rendering-only, default-off.
**Design:** 3 replicates per arm = 6 `run-protocol` runs (NOT underpowered), arms interleaved
(c-r1, t-r1, c-r2, t-r2, c-r3, t-r3) so any temporal/API drift is balanced across arms.
**Protocol (both arms):** `vtrace-indexed --capsule-intent auto --capture-product-v2-accounting --disable-pivot-check`.
**Only knob varied:** `VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS` (control=`0`, treatment=`1`).
**Not enabled:** pivot-revision-pass, pivot-inspection-enforcement, agent-discovered-tests verification, `--allow-docker-verify`, any other experimental toggle.
**Canonical evaluation:** `--mode evaluate --eval-mode docker` on the 6 M40 labels (canonical SWE-bench resolution; NOT the diagnostic verifier).

> Scope caveat: this is a single-instance behavioral probe (n=3/arm). It tests *mechanism* on the
> instance M39 was designed around — not general product performance. Do not over-generalize.

---

## 1. Executive verdict

- **Did the semantic hypothesis change the edit decision? NO.** All 6 runs (control and treatment)
  edited **only `sphinx/domains/python.py`**. `ast.py::unparse` edit rate is **0/3 in both arms.**
- **Did it improve resolution? NO.** Canonical Docker resolution is **0/3 in both arms.** The gold
  fix requires editing **both** `python.py` **and** `sphinx/pycode/ast.py`, and FAIL_TO_PASS includes
  `tests/test_pycode_ast.py::test_unparse[()-()]`. Because resolution needs *all* FAIL_TO_PASS, a
  `python.py`-only patch **cannot resolve this instance** — and no run produced the ast.py edit.
- **Did it increase token/tool burden? Marginally, within noise.** Treatment adds a deterministic
  **+114-token** injected section (median injected context 2890 → 3007). Median tool calls 6 → 7,
  median cost $0.247 → $0.284. Per-rep cost is turn-driven and noisy (the single most expensive run
  is **control** r1 at $0.47); no material regression.
- **What DID change:** treatment raised `ast.py` **inspection** from 2/3 → **3/3** and, in one rep
  (treatment r1), shifted the rule-out *reasoning* toward output-correctness ("empty tuple should
  render as `Tuple[()]`"). But inspection/reasoning never converted into the ast.py **edit**.

**Mechanism:** control = `control_baseline_gap` (×3); treatment = `hypothesis_seen_but_no_edit` (×3).

**Recommendation: B** — treatment changes reasoning/inspection but not edits. Strengthen the
hypothesis into a **non-enforcing final edit-sufficiency checklist** (see §7). Keep it default-off.

---

## 2. Run matrix

All 6 runs valid (`vtraceContextInjected=true`, `exitCode=0`, patch produced). All canonical evals ran (Docker).

| label | arm | rep | valid | patch | hyp rendered | hyp tokens | ast surfaced | ast inspected (read/grep) | ast mentioned (reasoning) | ast.py edited | python.py edited | resolved |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| eval-m40-control-sphinx-7462-r1 | control | 1 | ✓ | ✓ | — | 0 | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m40-control-sphinx-7462-r2 | control | 2 | ✓ | ✓ | — | 0 | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ |
| eval-m40-control-sphinx-7462-r3 | control | 3 | ✓ | ✓ | — | 0 | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m40-treatment-sphinx-7462-r1 | treatment | 1 | ✓ | ✓ | ✓ | 114 | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m40-treatment-sphinx-7462-r2 | treatment | 2 | ✓ | ✓ | ✓ | 114 | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m40-treatment-sphinx-7462-r3 | treatment | 3 | ✓ | ✓ | ✓ | 114 | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |

Per-run tool/token/cost detail:

| label | tool calls | Read | Grep/Search | Bash | unique files touched | input tokens (uncached) | cacheRead | injected ctx tokens | cost (USD) | turns |
|---|---|---|---|---|---|---|---|---|---|---|
| control-r1 | 7 | 2 | 1 | 0 | 1 | 167 | 753,897 | 2890 | 0.4703 | 23 |
| control-r2 | 6 | 2 | 0 | 0 | 1 | 132 | 603,920 | 2890 | 0.2472 | 18 |
| control-r3 | 5 | 2 | 1 | 0 | 1 | 104 | 460,788 | 2890 | 0.1954 | 14 |
| treatment-r1 | 8 | 1 | 1 | 0 | 1 | 174 | 806,168 | 3007 | 0.4628 | 24 |
| treatment-r2 | 6 | 2 | 1 | 0 | 1 | 132 | 605,164 | 3007 | 0.2589 | 18 |
| treatment-r3 | 7 | 2 | 1 | 0 | 1 | 153 | 712,759 | 3007 | 0.2844 | 21 |

> `input tokens` is the *uncached* prompt portion only (prompt caching is active); the real context
> volume is `cacheRead`. Both track turn count, which is agent-loop noise. Cost is the better burden proxy.

---

## 3. Mechanism analysis — focus on `ast.py::unparse`

Gold-patch ground truth (from `swe-bench-100.jsonl`):

- Gold edits **`sphinx/domains/python.py`** (guard `result.pop()` for empty `ast.Tuple`) **and**
  **`sphinx/pycode/ast.py`** (`unparse` of an empty `ast.Tuple` must return `"()"` instead of `", ".join([]) == ""`).
- FAIL_TO_PASS = `tests/test_domain_py.py::test_parse_annotation`, `tests/test_pycode_ast.py::test_unparse[()-()]`.
- The `ast.py` test asserts an empty tuple renders as `"()"` — **exactly** the "empty container must
  render, not just avoid crashing" failure the hypothesis is designed to flag.

Per-run mechanism:

- **Control (×3) → `control_baseline_gap`.** `ast.py::unparse` is surfaced in the injected context in
  every run (the secondary pivot), and the agent reaches it in reasoning, but rules it out and edits
  only `python.py`. Reproduces the known python.py-only behavior. ast inspection 2/3.
- **Treatment (×3) → `hypothesis_seen_but_no_edit`.** The hypothesis renders in every run (114 tokens,
  naming `sphinx/domains/python.py::unparse` + `sphinx/pycode/ast.py::unparse` with the empty-container
  line). The agent **grep/read-inspects `ast.py::unparse` in all 3 runs (3/3)** and discusses it, but
  **never edits it.** No run reached `hypothesis_action_success`.

The hypothesis successfully moved the agent one step along the chain
(surfaced → **inspected** → mentioned) but failed to flip the terminal step (**edit**).

---

## 4. Aggregate A/B table

| metric | control (n=3) | treatment (n=3) | delta |
|---|---|---|---|
| `ast.py` edit rate | **0% (0/3)** | **0% (0/3)** | 0 |
| `ast.py` inspection rate (read/grep) | 67% (2/3) | **100% (3/3)** | **+33 pp** |
| canonical resolved rate | **0% (0/3)** | **0% (0/3)** | 0 |
| median tool calls | 6 | 7 | +1 |
| median input tokens (uncached) | 132 | 153 | +21 |
| median injected-context tokens | 2890 | 3007 | **+117** (the rendered section) |
| median cost (USD) | 0.2472 | 0.2844 | +0.037 (within run-to-run noise) |

The only directional movements are **inspection rate (+33pp)** and the **deterministic +114/117-token
injected section**. Edit rate and resolved rate are flat at zero; tool/cost deltas are inside the
noise band (control r1 alone costs more than treatment r2 and r3 combined-median).

---

## 5. Reasoning analysis — did treatment change the wrong rule-out?

The target faulty inference (from M38):

```
from:  ", ".join([]) does not crash, so ast.py::unparse needs no edit
to:    an empty tuple must RENDER as "()", so ast.py::unparse needs an edit
```

**Control** — confident-but-wrong rule-out on crash-avoidance grounds, every rep:

- r1: *"`py::unparse` handles empty tuples gracefully since `", ".join([])` simply returns an empty string without errors."*
- r2: *"`py::unparse` handles empty tuples gracefully by just joining an empty sequence into an empty string."*
- r3: *"`Tuple` case just returns an empty string for empty tuples, which doesn't crash."*

The agent frames the task as the **crash symptom** (`IndexError` from `result.pop()`) and treats
"does not crash" as "correct" — the exact gap the hypothesis targets.

**Treatment** — the framing partially shifted, but unevenly:

- **r1 (closest):** *"An empty tuple would return an empty string, but `Tuple[()]` should probably
  render as `Tuple[()]` to properly represent an empty tuple annotation."* — this is the
  output-correctness reframe the hypothesis intends. **But the agent applied the guard only to
  `python.py`'s local `unparse` and still did not edit `ast.py`.**
- **r2/r3 (reverted to crash-framing despite inspecting ast.py):** *"`join()` … gracefully handles
  empty tuples by returning an empty string …"* (r2); *"`join()` … safely returns an empty string …
  so those don't have the same vulnerability"* (r3). The agent **read/grepped `ast.py::unparse`**,
  then re-applied the "no crash ⇒ no fix" rule-out.

**Conclusion:** treatment moved the agent from "didn't reliably look" to "always looked", and in 1/3
reps produced the correct output-correctness inference — but the dominant final reasoning across the
arm remained crash-avoidance, and **the rule-out was never converted into the ast.py edit.** The
hypothesis influenced *inspection and partial reasoning*, not the *edit decision*.

---

## 6. Failure / regression analysis

- **No resolution regression and no resolution gain:** 0/3 both arms. Structurally, this instance
  cannot be resolved without the `ast.py` edit (FAIL_TO_PASS gate), and no run produced it.
- **No tool/cost regression of concern:** +1 median tool call, +$0.037 median cost — within the
  per-run noise (the most expensive run is control r1). The deterministic cost is the +114-token
  section, which is small and bounded by construction (MAX_GROUPS×MAX_FILES_PER_GROUP).
- **No invalid/inconclusive runs:** all 6 valid, all evals ran.
- **Validity of the treatment signal:** the hypothesis rendered correctly in all 3 treatment runs and
  never rendered in control — the knob behaved exactly as designed (rendering-only, default-off).

---

## 7. Recommendation

**B. Treatment changes reasoning/inspection but not edits → strengthen the hypothesis into a
non-enforcing final edit-sufficiency checklist (keep default-off).**

Rationale:

- The hypothesis demonstrably moves the agent *up to the edit boundary*: inspection 67%→100% and, in
  r1, the correct output-correctness reframe. So the signal content is right and lands early enough to
  be read.
- It fails at the *last step*: even after inspecting `ast.py::unparse`, the agent re-applies the
  "no crash ⇒ no fix" rule-out at decision time. An **advisory hypothesis placed near the top of the
  context** is too far (temporally) from the moment the agent finalizes its edit set.
- The natural next iteration is a **non-enforcing, end-of-context edit-sufficiency checklist** that
  re-surfaces, at the point of patch finalization, the question the hypothesis poses: *"for each
  surfaced same-name implementation, did you verify output correctness, not just crash avoidance —
  and if not, why is no edit needed?"* This keeps it advisory (no `PIVOT_DECISION` enforcement, no
  revision pass, no verifier) while moving the prompt closer to the decision point.

This is explicitly **not** recommendation A (no edit, no pass-rate gain), **not** C (there *was* a
behavioral effect — inspection and partial reasoning moved), and **not** D (no cost/resolution harm).
Results were consistent across 3 reps, so E (noise) does not apply.

---

## Appendix — provenance & guardrails

- Source code **unchanged** this milestone — M40 is benchmark + analysis only. (No retrieval/ranking/
  scoring/candidate-generation touched; deterministic retrieval no-change proof therefore N/A.)
- Revision pass, pivot-inspection enforcement, agent-discovered-tests verification, and the diagnostic
  verifier (`--allow-docker-verify`) were all **avoided**.
- Structured outputs: `stage5_m40_semantic_hypothesis_live_ab.csv`, `stage5_m40_semantic_hypothesis_live_ab.json`.
- Raw run artifacts under `results/runs/eval-m40-*/` are untracked and not staged.
