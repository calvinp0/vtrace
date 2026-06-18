# Stage 5 — M46: budget-fixed edit-sufficiency A/B (sphinx-doc__sphinx-7462)

**Date:** 2026-06-18
**Instance:** `sphinx-doc__sphinx-7462` (only)
**Budget fix under test:** M45 **section-priority context truncation** (`9c75181`). The injector's
old global head-preserving slice was section-blind and, on the M42 treatment render, clipped the TAIL —
the essential **Pivot neighborhood** block — while retaining optional advisory sections at the head.
M45 instead drops whole non-essential sections (diagnostic → optional → important) before ever clipping
essential evidence.
**Hypothesis re-tested (de-confounded):** with essential evidence now preserved, does the M39
**semantic edit hypothesis** + M41 **edit-sufficiency checklist** treatment make the agent edit
`sphinx/pycode/ast.py::unparse` and resolve the instance?
**Design:** 3 replicates/arm = 6 `run-protocol` runs, arms interleaved (c-r1, t-r1, c-r2, t-r2, c-r3, t-r3)
to balance temporal/API drift. **Protocol (both arms):**
`vtrace-indexed --capsule-intent auto --capture-product-v2-accounting --disable-pivot-check`.
**Only knobs varied (together):** `VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS` +
`VTRACE_ENABLE_EDIT_SUFFICIENCY_CHECKLIST` (control = both `0`, treatment = both `1`).
**Not enabled:** pivot-revision-pass, pivot-inspection-enforcement, agent-discovered-tests verification,
the diagnostic verifier (`--allow-docker-verify`), any other experimental toggle.
**Canonical evaluation:** `--mode evaluate --eval-mode docker` on the 6 M46 labels (canonical SWE-bench
resolution; NOT the diagnostic verifier).

> Scope caveat: single-instance behavioral probe (n=3/arm). It tests *mechanism* on the instance M39/M41/M45
> were designed around — not general product performance. Do not over-generalize.

> **Interpretation constraint honored.** Because M45 may drop optional sections when over budget, this report
> states exactly which treatment sections survived. In all 3 treatment runs the **M41 edit-sufficiency
> checklist was dropped by section-priority budget** (along with the Multi-Pivot Action Plan); only the M39
> semantic hypothesis survived. The treatment arm is therefore reported as
> **"semantic hypothesis retained, checklist dropped by section-priority budget,"** *not* a full
> "semantic + checklist" treatment.

---

## 1. Executive verdict

- **After M45 budget protection, did the treatment change the edit decision? NO.** All 6 runs (control and
  treatment) edited **only `sphinx/domains/python.py`**. `ast.py::unparse` edit rate is **0/3 in both arms.**
- **Did it improve resolution? NO.** Canonical Docker resolution is **0/3 in both arms** (`resolvedCount=0`
  ×6). Gold requires editing **both** `python.py` **and** `sphinx/pycode/ast.py`, and FAIL_TO_PASS includes
  `tests/test_pycode_ast.py::test_unparse[()-()]`. A `python.py`-only patch **cannot resolve** this instance,
  and no run produced the `ast.py` edit.
- **Was essential evidence preserved? YES — this is what M45 fixed.** In all 3 treatment runs the render was
  over budget (12,751 > 12,000 chars) and `truncationMode=section_priority` dropped optional sections while
  keeping the full **Pivot neighborhood**: `essentialSectionsEvicted=false` (3/3), pivot-neighborhood
  preserved (3/3). The M42 confound — the tail pivot-neighborhood being silently head-sliced — **is gone.**
- **Were the requested optional treatment sections actually injected or dropped? The checklist was DROPPED.**
  Treatment injected the **Semantic Edit Hypothesis (3/3)** but the **M41 Edit-Sufficiency Checklist was
  dropped by section-priority budget (0/3 injected)**, together with the Multi-Pivot Action Plan
  (`droppedSectionNames=["Multi-Pivot Action Plan","Final Edit-Sufficiency Check"]`, 3/3).

**Mechanism:** control = `control_baseline_gap` (×3); treatment = `treatment_degraded_by_budget_drop` (×3)
— the requested checklist was budget-dropped, so the arm is not the full intended treatment. On its
*delivered* portion (semantic hypothesis injected + essentials preserved) the treatment is also
`budget_protected_seen_but_no_edit`: it inspects/mentions `ast.py` and does not edit it. No
`budget_protected_action_success`, no `regression`, no `inconclusive`.

**Recommendation: C** — with essential evidence preserved (`essentialSectionsEvicted=false`) and the ast.py
edit rate still **0/3** in treatment, the pre-registered decision rule binds: stop first-pass text-prompt
approaches for sphinx and return to the gated revision/enforcement/verification branch. **Do not propose
another stronger first-pass text prompt.** (Why C and not D is argued in §8.)

---

## 2. Run matrix

All 6 runs valid (`vtraceContextInjected=true`, exit 0, patch produced). All canonical Docker evals ran
(`evaluationRan=true`, `resolvedCount=0` for all 6).

| label | arm | rep | valid | patch | sem req | sem inj | chk req | chk inj | mp inj | trunc mode | dropped | ess. evicted | pivot-nbhd kept | ast surfaced | ast inspected | ast mentioned | ast.py edited | python.py edited | resolved |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| eval-m46-control-sphinx-7462-r1 | control | 1 | ✓ | ✓ | — | ✗ | — | ✗ | ✓ | none | — | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m46-control-sphinx-7462-r2 | control | 2 | ✓ | ✓ | — | ✗ | — | ✗ | ✓ | none | — | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m46-control-sphinx-7462-r3 | control | 3 | ✓ | ✓ | — | ✗ | — | ✗ | ✓ | none | — | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m46-treatment-sphinx-7462-r1 | treatment | 1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | section_priority | MP+checklist | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m46-treatment-sphinx-7462-r2 | treatment | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | section_priority | MP+checklist | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| eval-m46-treatment-sphinx-7462-r3 | treatment | 3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | section_priority | MP+checklist | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |

> "dropped" = `vtraceContextBudget.droppedSectionNames`; "MP+checklist" =
> `["Multi-Pivot Action Plan","Final Edit-Sufficiency Check"]`. "sem req / chk req" = env flag for the arm;
> "inj" = section actually present in the injected (post-truncation) context. The checklist is **requested
> but not injected** in treatment because budget priority dropped it.

Per-run tool/token/cost detail:

| label | tool calls | Read | Grep/Search | Bash | unique files edited | input tok (uncached) | cache-read tok | injected ctx chars | cost (USD) | turns | mechanism |
|---|---|---|---|---|---|---|---|---|---|---|---|
| control-r1   | 8 | 2 | 1 | 3 | 1 | 174 | 788,814 | 11,561 | 0.4390 | 24 | control_baseline_gap |
| control-r2   | 7 | 1 | 1 | 3 | 1 | 153 | 718,609 | 11,561 | 0.3092 | 21 | control_baseline_gap |
| control-r3   | 4 | 1 | 1 | 0 | 1 | 90  | 389,430 | 11,561 | 0.1903 | 12 | control_baseline_gap |
| treatment-r1 | 4 | 1 | 1 | 0 | 1 | 90  | 352,405 | 11,526 | 0.3064 | 12 | treatment_degraded_by_budget_drop |
| treatment-r2 | 6 | 1 | 1 | 2 | 1 | 132 | 603,236 | 11,526 | 0.2660 | 18 | treatment_degraded_by_budget_drop |
| treatment-r3 | 9 | 2 | 1 | 4 | 1 | 188 | 893,325 | 11,526 | 0.3303 | 26 | treatment_degraded_by_budget_drop |

> **Injected-context note.** `injected ctx chars` = `vtraceContextChars` (the ACTUAL post-truncation injected
> capsule context). Under M45 these are now authoritative: control = 11,561 (render fit budget, no
> truncation); treatment = 11,526 (render 12,751 → section-priority-reduced to 11,526). `input tok` is the
> uncached prompt portion only (prompt caching active; the bulk is cache-read, shown) — it and turn count are
> agent-loop noise; cost is the better burden proxy.

---

## 3. Budget integrity analysis (control vs treatment context budget telemetry)

`maxChars` budget = **12,000** for both arms.

| field | control (3/3) | treatment (3/3) |
|---|---|---|
| `preTruncationChars` (render) | 11,561 | 12,751 |
| `postTruncationChars` (injected) | 11,561 | 11,526 |
| `truncationMode` | `none` | `section_priority` |
| `droppedSectionNames` | — | `Multi-Pivot Action Plan`, `Final Edit-Sufficiency Check` |
| `optionalSectionsDropped` | false | **true** |
| `optionalSectionsRetained` | (n/a — none over budget) | `Semantic Edit Hypothesis` |
| `essentialSectionsEvicted` | **false** | **false** |
| Pivot neighborhood preserved | yes | **yes** |

**Section composition (capsule render):**

- **Control** (fits budget, untruncated): inspect-first · **Multi-Pivot Action Plan** · Multiple edit targets ·
  Pivot inspection contract · Actionability hints · **Pivot neighborhood**. (Semantic/checklist OFF.)
- **Treatment** (over budget → reduced): inspect-first · ~~Multi-Pivot Action Plan~~ · **Semantic Edit
  Hypothesis** · Multiple edit targets · Pivot inspection contract · Actionability hints ·
  ~~Final Edit-Sufficiency Check~~ · **Pivot neighborhood**.

**The M42→M45 de-confounding is confirmed.** Under the M42 legacy head-slice, the treatment render (≈12,752
chars) was clipped to 12,000 from the *tail*, evicting ≈752 chars of the essential Pivot neighborhood while
the optional advisory sections at the head survived. Under M45, the same over-budget render instead **drops
the two optional advisory sections (Multi-Pivot + checklist) whole and preserves the full Pivot
neighborhood** — `essentialSectionsEvicted=false` in every treatment run. Essential code evidence is now
intact in both arms.

**Net injected-advisory delta between arms.** After budget reduction, the only difference in injected
advisory text is: control injects the **Multi-Pivot Action Plan**; treatment injects the **Semantic Edit
Hypothesis** (both at essentially the same total size — 11,561 vs 11,526 chars). The **M41 Edit-Sufficiency
Checklist is injected in NEITHER arm** (OFF in control; budget-dropped in treatment). So M46 did not actually
deliver the checklist treatment it nominally toggled on.

---

## 4. Mechanism analysis — focus on `sphinx/pycode/ast.py::unparse`

Gold-patch ground truth (from `swe-bench-100.jsonl`):

- Gold edits **`sphinx/domains/python.py`** (guard `result.pop()` for an empty `ast.Tuple`/`ast.List`) **and**
  **`sphinx/pycode/ast.py`** (`unparse` of an empty `ast.Tuple` must return `"()"`, not `", ".join([]) == ""`).
- FAIL_TO_PASS = `tests/test_domain_py.py::test_parse_annotation`, `tests/test_pycode_ast.py::test_unparse[()-()]`.
- The `ast.py` test asserts an empty tuple renders as `"()"` — exactly the "empty container must render
  *correctly*, not just avoid crashing" failure the hypothesis/checklist were designed to flag.

`ast.py::unparse` is surfaced as the secondary pivot (`vtraceCapsulePivots[1]`) in **both** arms.

Per-arm mechanism:

- **Control (×3) → `control_baseline_gap`.** The agent inspects `ast.py::unparse` (3/3) — the injected
  **Multi-Pivot Action Plan** lists it as a co-edit target — and rules it out on the grounds that `join()`
  "safely returns `""` for empty tuples", then edits only `python.py`. Reproduces the known python.py-only
  behavior, now with essential evidence verified intact.
- **Treatment (×3) → `treatment_degraded_by_budget_drop`** (delivered portion:
  `budget_protected_seen_but_no_edit`). The Semantic Edit Hypothesis renders and is injected (3/3); the
  requested checklist is dropped by budget (0/3). The agent grep/read-inspects `ast.py::unparse` (3/3),
  discusses the empty-tuple output, and **rules it out** — never edits it (0/3). With the Pivot neighborhood
  preserved and the hypothesis injected, the terminal **edit** step still did not flip.

The decisive negative result: **even with the essential pivot-neighborhood evidence fully preserved and the
semantic hypothesis injected, treatment surfaced → inspected → mentioned `ast.py::unparse` but did not edit
it.** The M42 fear that the missing edit was an artifact of evidence eviction is refuted: the edit is absent
when the evidence is present.

---

## 5. Aggregate A/B table

| metric | control (n=3) | treatment (n=3) | delta |
|---|---|---|---|
| `ast.py` edit rate | **0% (0/3)** | **0% (0/3)** | 0 |
| `ast.py` inspection rate (read/grep) | 100% (3/3) | 100% (3/3) | 0 |
| `ast.py` mention / rule-out rate (reasoning) | 100% (3/3) | 100% (3/3) | 0 |
| canonical resolved rate | **0% (0/3)** | **0% (0/3)** | 0 |
| semantic hypothesis **actually injected** rate | 0% (0/3) | **100% (3/3)** | +100% |
| edit-sufficiency checklist **actually injected** rate | 0% (0/3) | **0% (0/3)** | 0 (budget-dropped) |
| essential-evidence eviction rate | 0% (0/3) | **0% (0/3)** | 0 |
| median tool calls | 7 | 6 | −1 (noise) |
| median input tokens (uncached) | 153 | 132 | −21 (noise) |
| median actual injected chars | 11,561 | 11,526 | −35 (≈equal) |
| median cost (USD) | 0.3092 | 0.3064 | −0.003 (noise) |
| median turns | 21 | 18 | −3 (noise) |

Edit rate, inspection rate, mention rate, and resolved rate are flat (0 / 100% / 100% / 0). The semantic
hypothesis is the only advisory actually delivered to treatment; the checklist injection rate is 0/3 in both
arms. Tool/cost/token/turn deltas are inside per-run agent-loop noise — there is **no burden regression**
(if anything treatment was marginally cheaper this batch).

---

## 6. Reasoning analysis — did treatment change the wrong rule-out?

Target faulty inference (from M38/M40/M42):

```
from:  ", ".join([]) does not crash, so ast.py::unparse needs no edit
to:    an empty tuple must RENDER as "()", so ast.py::unparse needs an edit
```

**Both arms reach the same wrong rule-out — the reframe did NOT happen this batch.** Unlike M42 (where the
checklist visibly moved treatment from pure crash-avoidance to an explicit, if wrong, output-correctness
deliberation), in M46 *both* control and treatment already reason about the empty-tuple *output* and both
conclude — incorrectly — that returning `""` is fine:

- **Control** (Multi-Pivot Action Plan injected): *"the `sphinx/pycode/ast.py::unparse` function uses
  `", ".join()` which safely returns `""` for empty tuples — no fix needed there"* (r2);
  *"ruled out because it uses `join()` which safely handles empty iterables"* (r3).
- **Treatment** (Semantic Edit Hypothesis injected): *"Looking at the `sphinx/pycode/ast.py::unparse` code …
  `", ".join()` which returns an empty string when given an empty sequence … handles empty lists correctly"*
  (r1); *"This handles empty tuples correctly — it returns an empty string `""`, which is fine"* (r2);
  *"handles empty tuples correctly by just joining an empty sequence, so that's fine"* (r3).

Two consequences worth recording:

1. **The reframe to "must render `()`" never occurs in either arm.** The semantic hypothesis did not convert
   the rule-out into the correct edit decision; it landed on the same "empty string is correct" judgment the
   M42 treatment reached — exactly inverting the ground truth (`test_unparse[()-()]` requires `"()"`).
2. **The agent's "checklist" language is NOT the dropped M41 section.** Treatment reasoning occasionally says
   it inspects ast.py "as required by the checklist" — but telemetry confirms the M41 Edit-Sufficiency Check
   section was **not injected** (dropped by budget). That phrasing derives from the *retained* important-tier
   co-edit guidance ("Multiple edit targets" / "Pivot inspection contract"), which is present in both arms.
   The genuine M41 checklist text never reached the agent in M46.

The residual gap is unchanged from M42: a **ground-truth fact** ("empty tuple must render `"()"`") that no
advisory text reliably injects — it requires a signal the agent can be *wrong against*, i.e. the failing
`test_unparse[()-()]`.

---

## 7. Failure / regression analysis

- **No resolution gain and no regression:** 0/3 both arms; structurally unresolvable without the `ast.py`
  edit (FAIL_TO_PASS gate), and no run produced it.
- **No tool/cost/turn regression:** medians ≈equal or marginally favor treatment (tool calls 7→6, cost
  \$0.309→\$0.306, turns 21→18) — run-to-run noise.
- **No essential-evidence eviction:** `essentialSectionsEvicted=false` in all 6 — M45 behaved as designed.
- **Treatment fidelity gap (the notable finding):** the requested **M41 checklist was dropped by
  section-priority budget in all 3 treatment runs**, so M46 did not deliver the full "semantic + checklist"
  treatment it toggled on. The semantic hypothesis was delivered. This is M45 working as designed (drop
  optional advisory before clipping essential evidence), but it means the checklist arm of M42 cannot be
  re-tested at the current 12,000-char budget without the checklist being evicted.
- **No invalid/inconclusive runs:** all 6 valid, all evals ran.

---

## 8. Final recommendation for this branch

**C. Treatment preserves essential evidence and still changes inspection/reasoning but does not edit
`ast.py` → stop first-pass text-prompt approaches for sphinx and return to the gated
revision/enforcement/verification branch. Do not propose another stronger first-pass text prompt.**

Per the pre-registered decision rule: **ast.py edit rate is 0/3 in treatment AND
`essentialSectionsEvicted=false` ⇒ choose C.** Both conditions hold (0/3; false ×3), so the rule binds.

**Why C and not D**, given the checklist was budget-dropped (D = "redesign optional-section cap/priority
before another live run"):

- D presupposes that *delivering the checklist* might flip the edit — i.e. that the only reason treatment
  failed is that its section was evicted. **M42 already refutes that:** there, the checklist *was* injected
  in full (under the legacy slice) and treatment *still* edited only `python.py` (0/3 ast.py), reaching the
  same wrong "empty string is correct" rule-out. So we have both directions covered: checklist-present
  (M42) → no edit; checklist-absent-but-essentials-preserved + hypothesis-present (M46) → no edit.
- Redesigning the budget to fit the checklist would therefore just re-run a first-pass text approach already
  shown to fail — precisely what the pre-registered rule forbids ("do not propose another stronger first-pass
  text prompt").
- The residual gap is a ground-truth fact (`Tuple[()]` ⇒ `"()"`) that advisory text cannot reliably supply;
  it needs a verification signal the agent can be wrong against (the failing `test_unparse[()-()]`), which is
  the province of the gated **revision/enforcement/verification** branch (M12 enforcement + M14/M15 revision
  with a verification policy).

This is **not** A (no edit, no pass-rate gain), **not** B (treatment did not edit ast.py, so there is no
synthesis failure to audit), **not** D (per above — the failure is not "the checklist was missing"; the
fully-injected checklist also failed in M42), and **not** E (no cost/resolution harm; injected sizes are
≈equal and there is no run-time regression).

**Action:** keep `VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS` and `VTRACE_ENABLE_EDIT_SUFFICIENCY_CHECKLIST`
default-off (do not productize), close the first-pass-text line of attack for sphinx-7462, and resume the
gated revision/enforcement branch where a verification signal can ground the empty-tuple fact.

---

## Appendix — provenance & guardrails

- Source code **unchanged** this milestone — M46 is benchmark + analysis only. (No retrieval / ranking /
  scoring / candidate-generation touched; deterministic retrieval no-change proof therefore N/A.)
- Revision pass, pivot-inspection enforcement, agent-discovered-tests verification, and the diagnostic
  verifier (`--allow-docker-verify`) were all **avoided**. No cross-implementation guardrail implemented.
- Canonical evaluation only: `--mode evaluate --eval-mode docker` on the 6 M46 labels (`resolvedCount=0` ×6).
- Structured outputs: `stage5_m46_budget_fixed_edit_sufficiency_ab.csv`,
  `stage5_m46_budget_fixed_edit_sufficiency_ab.json`.
- Raw run artifacts under `results/runs/eval-m46-*/` are untracked and not staged.
