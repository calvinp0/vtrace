# Stage 5 — M35: Multi-Pivot Action Plan

Read-only recomputation over the captured M32 vtrace runs. This script executes nothing — no live agents, no Docker, no SWE-bench evaluation, no artifact mutation. It reads the persisted capsule manifest (the same pivots the live render saw) and the immutable `_vtrace_instructions.snapshot.md`, rebuilds the M35 action plan, and checks whether the missed gold co-edit pivot is now surfaced at the top. Gold files label which secondary was the required co-edit; they are NEVER an input to the plan builder (it sees only VTRACE-derived pivots/hints). Token figures use the same chars/4 estimator that sizes Capsule v2 — an approximation, never a tokenizer count.

## 1. Executive verdict

**Yes for sphinx-7462; no (honestly) for seaborn-3187 — and the split is informative.** M35 adds a compact, first-pass `## Multi-Pivot Action Plan` at the TOP of the injected capsule that names the required inspection set (lead + secondary pivots/co-edit candidates) with edit-or-rule-out wording. For sphinx-7462 the missed gold co-edit `sphinx/pycode/ast.py` is a VTRACE-ranked pivot, so the plan now promotes it to the top-level required inspection set — the genuine `retrieval_success_action_failure` is now explicitly actionable. For seaborn-3187 the gold co-edit `seaborn/utils.py` was ranked only as *support* (the ranked secondary is the distractor `seaborn/relational.py`), so the plan cannot surface it without a retrieval/ranking change — which M35 deliberately does not make. Retrieval is unchanged (byte-identical eval), and neither pivot revision nor pivot-inspection enforcement was enabled by default.

## 2. Root cause from M32/M34

M34 relabeled the M32 genuine failures functionally and ruled out retrieval as the bottleneck: in every genuine failure the gold was surfaced (`retrieval_success_*`). The remaining VTRACE-attributable failures are all `retrieval_success_action_failure` — the agent edits the lead pivot and skips a required co-edit. The secondary pivot was ALREADY in the injected block, but framed as supporting / inspect-or-rule-out and buried below the bulky pivot bodies (sphinx: `ast.py::unparse` first appeared at line 20, under “## VTRACE inspect-first (guidance, not enforcement; confidence: high)”). So this targets ACTIONABILITY (salience of evidence the capsule already has), not retrieval (which candidates are found). The fix raises salience; it adds no new evidence and changes no candidate set.

## 3. Rendering / design change

A new pure module `src/capsuleV2/multiPivotActionPlan.ts` builds the plan from the SAME inputs the pivot inspection contract uses (`result.pivots` + multi-file co-edit hints) and renders it FIRST in `renderCapsuleV2Human` — before the verbose `## Multiple edit targets` guidance and the bulky pivot bodies, so it survives char-budget truncation and is read first. Before/after for sphinx-7462:

Before — the secondary was present but low-salience (excerpt of the captured snapshot):

```text
(line 20, under “## VTRACE inspect-first (guidance, not enforcement; confidence: high)”)
sphinx/pycode/ast.py::unparse … Why: actionable function — exercised by a failing test;
symbol-name match. Framed as "inspect or rule out" / "hidden candidate", below the lead.
```

After — the new top-of-block action plan (rebuilt from the captured pivots):

```text
## Multi-Pivot Action Plan

This task likely requires checking more than one location before finalizing.

Required inspection set:
1. sphinx/domains/python.py::_parse_annotation (lead pivot) — base 3; +[multi-evidence(3) +0.2, strong-exact +0.1, specific-impl(function) +0.08] => 3.…
2. sphinx/pycode/ast.py::unparse (pivot) — base 3.67; +[multi-evidence(3) +0.2, strong-exact +0.1, specific-impl(function) +0.08] =>…

Before final answer:
- inspect each required pivot,
- either edit it, or rule it out with a source-grounded reason it is not needed,
- do not stop after the first plausible file while a required pivot is still unchecked.
```

## 4. Triggering and compactness

The plan renders ONLY when there is real multi-pivot / co-edit evidence: it reuses the pivot inspection contract's gate, which fires for ≥2 selected pivots OR a multi-file co-edit hint, and requires at least one secondary inspection target. Single localized / no-context tasks render nothing. Compactness bounds: at most 3 required pivots (lead included), one short reason per pivot (clipped to 90 chars), exactly three obligation bullets, and NO source excerpts (no code fences, no pivot bodies). Measured added cost below.

## 5. Offline validation on sphinx / seaborn

| instance | label | missed pivot | present before? | before location/prominence | after plan includes it? | after role | after reason | added chars/tokens | targets actionability gap? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | eval-m32-product-vtrace-sphinx-7462-r1 | sphinx/pycode/ast.py | yes | line 20, “## VTRACE inspect-first (guidance, not enforcement; confidence: high)” | **yes** | pivot | base 3.67; +[multi-evidence(3) +0.2, strong-exact +0.1, specific-impl(function) +0.08] =>… | 640 ch / 160 tok | yes |
| mwaskom__seaborn-3187 | eval-m32-product-vtrace-seaborn-3187-r1 | seaborn/utils.py | yes | line 22, “## VTRACE inspect-first (guidance, not enforcement; confidence: medium)” | no | — | — | 632 ch / 158 tok | no (retrieval gap) |

### sphinx-doc__sphinx-7462 — rendered action plan (after)

```text
## Multi-Pivot Action Plan

This task likely requires checking more than one location before finalizing.

Required inspection set:
1. sphinx/domains/python.py::_parse_annotation (lead pivot) — base 3; +[multi-evidence(3) +0.2, strong-exact +0.1, specific-impl(function) +0.08] => 3.…
2. sphinx/pycode/ast.py::unparse (pivot) — base 3.67; +[multi-evidence(3) +0.2, strong-exact +0.1, specific-impl(function) +0.08] =>…

Before final answer:
- inspect each required pivot,
- either edit it, or rule it out with a source-grounded reason it is not needed,
- do not stop after the first plausible file while a required pivot is still unchecked.
```

Note: Missed gold co-edit is a ranked pivot — the action plan promotes it to the top-level required inspection set with edit-or-rule-out wording. (Reasons shown are the captured manifest rank reasons — offline the manifest persists ranking math, not the richer evidence strings the live render uses; the validated fact is which files surface and in what role.)

### mwaskom__seaborn-3187 — rendered action plan (after)

```text
## Multi-Pivot Action Plan

This task likely requires checking more than one location before finalizing.

Required inspection set:
1. seaborn/_core/scales.py::_setup (lead pivot) — base 3; +[multi-evidence(3) +0.2, strong-exact +0.1, specific-impl(method) +0.08] => 3.38
2. seaborn/relational.py::scatterplot (pivot) — base 3.657; +[multi-evidence(3) +0.2, strong-exact +0.1, specific-impl(function) +0.08] =…

Before final answer:
- inspect each required pivot,
- either edit it, or rule it out with a source-grounded reason it is not needed,
- do not stop after the first plausible file while a required pivot is still unchecked.
```

Note: Missed gold co-edit (seaborn/utils.py) is NOT a VTRACE-ranked pivot here (the ranked secondary is a different file), so the action plan cannot surface it without a retrieval/ranking change — out of M35 scope. (Reasons shown are the captured manifest rank reasons — offline the manifest persists ranking math, not the richer evidence strings the live render uses; the validated fact is which files surface and in what role.)

## 6. Accounting impact

M34's `ProductV2Accounting` gains a `multiPivotActionPlanTokens` component (and the `multiPivotActionPlan` injected-component bucket + heading classifier), so the section is attributed to its own bucket, not folded into `coeditHint`. Added cost when the section renders:

| instance | added chars | added tokens (chars/4) |
| --- | ---: | ---: |
| sphinx-doc__sphinx-7462 | 640 | 160 |
| mwaskom__seaborn-3187 | 632 | 158 |

Both runs add ~158–160 tokens — a small, bounded surcharge on a block that already runs ~2600–3100 injected tokens (M34), and far smaller than the `actionabilityHints` section it complements. When the gate does not fire, the surcharge is exactly 0.

## 7. Backward compatibility / default behavior

Additive only. `multiPivotActionPlanTokens` is a new field; every legacy accounting field is preserved, and a snapshot with no action-plan section attributes 0 to the new bucket. The section is part of the normal advisory `vtrace-indexed` render — it requests NO machine-readable decision markers and is independent of the M12 enforcement block. Pivot revision (`--pivot-revision-pass`) and pivot-inspection enforcement (`--pivot-inspection-enforcement`) remain OFF by default; no default flag changed. Retrieval/ranking/candidate generation are untouched — the deterministic retrieval eval is byte-identical.

## 8. Next recommendation

**A (with a B rider).** Offline validation surfaces the missed pivot for the sphinx-7462 `retrieval_success_action_failure` (the plan now leads with `ast.py::unparse`), so a small live A/B on the M32 actionability failures is warranted: `vtrace-indexed` old vs `vtrace-indexed` + M35 action plan, no revision, no verifier, canonical Docker eval allowed AFTER patches. Rider (**B**): seaborn-3187's gold co-edit `seaborn/utils.py` is ranked only as support, so it is a co-edit-evidence/ranking gap, not a salience gap — improving co-edit evidence so such gold co-edits rank as pivots is the separate follow-up, still with no live run required to design.

