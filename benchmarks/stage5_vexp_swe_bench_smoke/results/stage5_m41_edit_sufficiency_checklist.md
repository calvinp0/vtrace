# Stage 5 — M41: end-of-context Edit-Sufficiency Checklist

**Date:** 2026-06-18
**Builds on:** M39 (semantic edit hypothesis, top-of-context) + M40 (live A/B verdict B).
**Change kind:** rendering-only, DEFAULT-OFF. No live agents, no Docker, no SWE-bench evaluation.

## 1. Executive verdict

**Yes.** We added a bounded, non-oracle, end-of-context **edit-sufficiency checklist** that targets
M40's `hypothesis_seen_but_no_edit` failure. It is gated behind a new default-off flag
`VTRACE_ENABLE_EDIT_SUFFICIENCY_CHECKLIST`, renders **only** when the M39 semantic-hypothesis builder
produces a paired-symbol group, is placed near the **final patch guidance** (after the bulky pivot/
support source bodies — in contrast to M39's top-of-context placement), and forces an explicit
edit-or-justify decision for the paired implementation in decision-point wording (output-correctness,
not crash-avoidance). Offline validation is clean across the sphinx positive and the seaborn / django /
no-context / single-pivot negatives; default-off behavior is additive (byte-identical when off);
retrieval CSVs are byte-identical. **Next recommendation: A** (M42 tiny live A/B, both flags off vs
both flags on).

## 2. Why M40 failed

M40 (sphinx-doc__sphinx-7462, 3 reps/arm) found the M39 top-of-context semantic hypothesis moved the
agent *up to the edit boundary but not over it*:

- `ast.py` inspection rose 67% → **100%**, and treatment r1 reached the intended output-correctness
  framing ("empty tuple should render as `Tuple[()]`").
- **But `ast.py` edit rate stayed 0/3** and resolved stayed 0/3. Treatment r2/r3 re-applied the
  crash-avoidance rule-out ("`join([])` returns an empty string, no vulnerability") *after* inspecting
  `ast.py`. The hypothesis is read early, in the top advisory cluster, then forgotten by the time the
  agent finalizes its edit set.

The M40 recommendation (B) was: re-surface the same hypothesis as a **non-enforcing edit-sufficiency
checklist at the decision point**. That is exactly this milestone.

## 3. Rendering placement

The injected capsule context (`renderCapsuleV2Human`) renders sections in this order:

```
intent / budget header
[M35 Multi-Pivot Action Plan]            ── top advisory cluster
[M39 ## Semantic Edit Hypothesis]        ── top advisory cluster (unchanged)
## Multiple edit targets
## Pivot inspection contract
## Actionability hints
<pivot source bodies>                    ── the bulky content
<edit-risk directives>
<support source bodies>
[M41 ## Final Edit-Sufficiency Check]    ── NEW: rendered LAST, near final patch decision
```

M39 sits at the **top** (survives char-budget truncation, read first). M41 sits at the **end** (read
last, immediately before the agent finalizes the patch). Both consume the **same**
`SemanticEditHypothesis` object — detection is decoupled from placement, so the two sections can never
disagree about the paired implementations. Offline validation confirms the checklist index is after
both the M39 top section and the pivot/support source bodies.

## 4. Before / after (sphinx-7462 shape)

**Before (M40, both flags' state at the time):** the top `## Semantic Edit Hypothesis` was the only
semantic section; nothing re-surfaced it at the patch-finalize point.

**After (M41, `VTRACE_ENABLE_EDIT_SUFFICIENCY_CHECKLIST=1`):** appended at the very end of the context:

```
## Final Edit-Sufficiency Check

Before finalizing the patch, revisit the semantic co-edit hypothesis. The surfaced pivots include
same-name implementations across files:

- sphinx/domains/python.py::unparse
- sphinx/pycode/ast.py::unparse

- If you changed one implementation of `unparse`, decide whether the paired implementation(s) above also need an edit.
- Do not rule out a paired implementation only because it avoids the crash; check whether it returns the correct output.
- If a paired implementation is left unedited, state the concrete output-preserving reason.
- For empty-container inputs, a path can avoid crashing yet still render the wrong text (e.g. an empty sequence rendering as "" instead of the correct token).
```

This is decision-point wording, not generic obligation text: it names the operation (`unparse`) and
both `file::symbol` targets, and frames the test as **output correctness vs crash avoidance** — the
precise inference M40 showed the agent getting wrong.

## 5. False-positive audit

Offline render matrix (`run_stage5_m41_edit_sufficiency_checklist.ts`; both flags on):

| fixture | checklist renders? | expected | match |
|---|---|---|---|
| sphinx-7462 paired `unparse` (python.py + pycode/ast.py) | **yes** | yes | ✓ |
| seaborn-3187 `penguins` across example files (non-operation symbol) | no | no | ✓ |
| django-13195 unrelated multi-file (distinct symbol names) | no | no | ✓ |
| no-context capsule | no | no | ✓ |
| single-pivot localized capsule | no | no | ✓ |

No false triggers. The checklist inherits the M39 builder's gate verbatim (≥2 distinct files defining
the same operation-like name, ≥1 pivot file), so seaborn (`penguins` is not operation-like), django
(no same-name pair), no-context (no pivots), and single-pivot (one file) all correctly yield no group
and therefore no checklist.

**Real-data anchor:** the M40 treatment captured context
(`runs/eval-m40-treatment-sphinx-7462-r1/raw/vtrace/_capsule_v2_context.md`) already contains the M39
`## Semantic Edit Hypothesis` with both `python.py::unparse` and `pycode/ast.py::unparse` — i.e. the
shared builder genuinely produces the paired group on the real instance. Because M41 keys off the same
group, the checklist would render there too. (That capture predates M41, so the heading itself is M39's.)

## 6. Accounting impact

Additive M34 sub-bucket `editSufficiencyChecklist{Tokens,Chars}`, reported separately from
`semanticEditHypothesis*`. On the sphinx-7462 shape (chars/4 estimator):

| component | tokens | chars |
|---|---|---|
| `semanticEditHypothesisTokens` (M39 top section) | 115 | — |
| `editSufficiencyChecklistTokens` (M41 checklist) | 183 | 731 |
| **combined added tokens (both flags on)** | **298** | — |

The checklist alone is ~183 tokens / 731 chars — bounded by construction (≤2 groups × ≤3 targets, one
fixed decision block, one optional empty-container line; no source excerpts duplicated). When either
section does not render (every negative fixture), its bucket is 0 — additive and backward-compatible.

## 7. Retrieval / candidate no-change proof

Rendering-only. The change touches `renderCapsuleV2Human` (append a section), the pure
`semanticEditHypothesis` module (new flag + renderer reusing the existing builder), and the offline
M34 accounting split — none of retrieval, ranking, pivot selection, co-edit detection, scoring, or
candidate generation. Proven:

- Deterministic retrieval eval CSVs **byte-identical** to the committed working-tree baselines:
  - `stage5_retrieval_eval_expanded.csv` — BYTE-IDENTICAL
  - `stage5_retrieval_eval_cross_repo_30.csv` — BYTE-IDENTICAL
- Test 12 asserts `renderCapsuleV2Human` does not mutate `result.pivots` / `result.support`.
- Default-off is a pure no-op (test 11: checklist-off output equals option-omitted output; enabling
  the checklist only appends — the off-output is a strict prefix of the on-output).

## 8. Next recommendation

**A.** Offline validation is clean (renders for sphinx, no false triggers, bounded cost, additive,
retrieval byte-identical). Proceed to **M42**: a tiny live A/B on sphinx-doc__sphinx-7462 —

- control = both `VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS` and
  `VTRACE_ENABLE_EDIT_SUFFICIENCY_CHECKLIST` off,
- treatment = both flags on,
- no revision pass, no pivot-inspection enforcement, no diagnostic verifier, no `--allow-docker-verify`,
- canonical Docker evaluation after the protocol runs.

The mechanism question for M42: does the decision-point placement convert the inspection M40 already
achieved into the `ast.py::unparse` edit (and thence resolution)?

## Relationship to the M39 flag (documented behavior)

Two **separate** default-off flags:

- `VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS=1` → renders the **top** `## Semantic Edit Hypothesis`.
- `VTRACE_ENABLE_EDIT_SUFFICIENCY_CHECKLIST=1` → renders the **end** `## Final Edit-Sufficiency Check`.

The checklist depends on the hypothesis **group**, so it internally builds the hypothesis (reusing the
same builder output) and can render **even when the top M39 section is disabled** (test 3b). For M41
validation both flags are exercised together; for the M42 live A/B, compare both-off vs both-on.

## Appendix — files changed / guardrails

- `src/capsuleV2/semanticEditHypothesis.ts` — new `EDIT_SUFFICIENCY_CHECKLIST_ENV` /
  `EDIT_SUFFICIENCY_CHECKLIST_HEADING`, `editSufficiencyChecklistEnabled`,
  `renderEditSufficiencyChecklistText` (reuses the existing builder; shared env-flag parse).
- `src/capsuleV2/renderHuman.ts` — `enableEditSufficiencyChecklist` option; build the hypothesis once
  and reuse for both sections; render the checklist after the support bodies.
- `benchmarks/stage5_vexp_swe_bench_smoke/m34_accounting.ts` — `editSufficiencyChecklist` component +
  heading classifier + `editSufficiencyChecklist{Tokens,Chars}`.
- `run_stage5_m34_accounting_and_functional_actionability.ts` — checklist row in `uncountedComponents`.
- Tests: `src/capsuleV2/editSufficiencyChecklist.test.ts` (12+ cases),
  `m34_accounting.test.ts` (heading map + dedicated-bucket case).
- Offline validation: `run_stage5_m41_edit_sufficiency_checklist.ts` →
  `stage5_m41_edit_sufficiency_checklist.json`.
- No live agents, no Docker, no SWE-bench evaluation, no `--allow-docker-verify`, no pivot revision,
  no pivot-inspection enforcement. Retrieval/ranking/scoring/candidate generation untouched.
