# M39 — semantic edit hypothesis for same-name multi-module pivots

**Feature:** a flag-gated, **DEFAULT-OFF**, additive, rendering-only capsule section
(`## Semantic Edit Hypothesis`) that names same-operation-name implementations across
files as *paired implementations* and warns the agent to verify **output correctness**,
not just crash avoidance. Targets the M38 sphinx-7462 `seen_but_deemed_unnecessary`
failure. Non-oracle: derived only from candidate symbols + their already-inlined source.

**Mode:** offline only. No live agents, no Docker, no canonical SWE-bench eval, no
retrieval/ranking/scoring/candidate changes.

---

## 1. Executive verdict

**Yes.** We added a non-oracle semantic hypothesis that targets the sphinx
edit-sufficiency failure. On the captured sphinx-7462 capsule it renders:

```
## Semantic Edit Hypothesis

The surfaced pivots include same-name implementations across files:

- sphinx/domains/python.py::unparse
- sphinx/pycode/ast.py::unparse

Hypothesis:
These may be paired implementations of one operation. If the fix changes how the
operation handles an edge case, verify both implementations for output correctness,
not just crash avoidance.
For empty-container cases, a path can avoid crashing but still render the wrong text.
```

The last two sentences attack the exact faulty inference M38 isolated — the agent ruled
out `ast.py::unparse` because `", ".join()` *does not crash*, missing that it returns
`""` (wrong) instead of `"()"`. The section separates *crash-avoidance* from *output
correctness* and is rendered in the top advisory cluster (before the bulky pivot bodies),
so it survives Stage 5's char-budget truncation.

It is **default-off** (`VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS`), additive, and changes
no retrieval/ranking/scoring/candidates (deterministic retrieval eval byte-identical).

---

## 2. Why M35 failed

M38 found the sphinx-7462 root cause is **`seen_but_deemed_unnecessary`**, not a missing
obligation. `ast.py::unparse` was surfaced in **24/24** runs with full source and an
explicit "edit-or-rule-out" obligation; the agent inspected it and **explicitly ruled it
out** with the same source-grounded-but-wrong reason every time. Five overlapping
obligation blocks already demanded inspect-or-rule-out (pivot inspection contract, multiple
edit targets, co-edit obligation, actionability checklist). The M35 multi-pivot action plan
added *another* obligation block and had **zero marginal effect** vs the M36 control — the
agent satisfies obligation text by ruling out. **More obligation text yields more confident
rule-outs, not edits.** The lever had to attack the *premise* of the rule-out (crash ≠
correctness), which is a semantic reframing, not an obligation.

---

## 3. Triggering rule (non-oracle)

A hypothesis is built (`buildSemanticEditHypothesis`) only when ALL hold:

1. an **operation-like** name (transformation/serialization/round-trip lexicon:
   `parse/unparse/render/format/serialize/encode/decode/dump/load/marshal/stringify/repr/
   compile/transform/convert/normalize/emit`, or a `to_/from_/as_` shape; **dunders
   excluded**) is defined in
2. **≥2 distinct files** among the surfaced pivots/support, where each file's "defined
   names" = the candidate's own `symbol` **plus any `def`/`class`** found in its inlined
   source body (this is how python.py's *nested* `def unparse` matches ast.py's module-level
   `unparse` — the two pivots' symbols are `_parse_annotation` and `unparse`, so a
   symbol-only comparison would miss it);
3. at least one defining file is a **pivot** (a primary edit target);
4. a **second distinct file** exists (another pivot or support co-edit candidate);
5. the relevance gate passes — the matched name is operation-like (true by construction
   here) **OR** the optional context text mentions output/parse/render/serialization/
   round-trip consistency.

**No oracle:** the rule reads only candidate symbols and the source bodies VTRACE already
surfaced. It uses **no** gold files, FAIL_TO_PASS/PASS_TO_PASS, benchmark labels, instance
ids, or test names. (Verified by a dedicated leakage test.)

For sphinx-7462 the matched name is `unparse`, defined in `sphinx/domains/python.py` (nested
in the `_parse_annotation` pivot) and `sphinx/pycode/ast.py` (pivot symbol) → triggers.

---

## 4. Rendered before/after for sphinx-7462

Reconstructed from the captured `eval-m36-treatment-sphinx-7462-r1` capsule (real pivot
source bodies).

**Before (no semantic section):** top of capsule = inspect-first guidance → Multi-Pivot
Action Plan → Multiple edit targets → Pivot inspection contract → co-edit obligation → …
all phrased as *inspect-or-rule-out*. (This is what the agent ruled out against in 24/24
runs.)

**After (flag on):** the same blocks, plus — in the top advisory cluster, right after the
action plan — the `## Semantic Edit Hypothesis` block shown in §1, naming
`sphinx/domains/python.py::unparse` and `sphinx/pycode/ast.py::unparse` and adding the
"verify output correctness, not crash avoidance" + empty-container sentences.

The empty-container sentence fires because the python.py pivot body contains `result.pop()`
(the classic empty-collection trap) — a non-oracle source signal.

---

## 5. False-positive audit

Run against the real captured capsules (reconstructed pivots + source bodies):

| instance | pivots | triggers? | reason |
|----------|--------|:---:|--------|
| **sphinx-doc__sphinx-7462** | `python.py::_parse_annotation`, `ast.py::unparse` | **YES** | `unparse` defined in 2 files (one nested), operation-like, both pivots |
| **mwaskom__seaborn-3187** | `scales.py::_setup`, `relational.py::scatterplot` | no | no operation-like same-name across files |
| **django-13195** | `response.py::delete_cookie`, `response.py::set_cookie` | no | same file; and `set_cookie`/`delete_cookie` are not the same name |
| **no-context / single-localized** | (≤1 pivot, or NoContext mode) | no | NoContext capsules early-return before this section; a single pivot / no second file → builder returns null |

Unit tests additionally confirm non-triggers for: single pivot; same-file same-name; same-
name across files with **no pivot file** (support-only); a non-operation name (`penguins`)
across files; and dunders (`__repr__`) across files. The context-relevance OR-branch is
tested to admit a non-lexicon name (`build`) only when the issue text is about rendered
output.

---

## 6. Accounting impact

Added to `ProductV2Accounting` (M34): `semanticEditHypothesisTokens` and
`semanticEditHypothesisChars`, plus a `semanticEditHypothesis` injected-component bucket and
a heading classifier on `## Semantic Edit Hypothesis` (checked *before* the broad `co-edit`
phrase test so it is not folded into `coeditHint`). Additive — every legacy field preserved;
a snapshot without the section attributes 0 to the new bucket.

Measured cost of the rendered sphinx section (chars/4 estimator):

| metric | value |
|--------|------:|
| chars | 456 |
| est. tokens | 114 |
| words | 60 (bound ≤150) |
| lines | 11 |

The accounting classifier attributes 100% of those 456 chars / 114 tokens to the
`semanticEditHypothesis` bucket. Cost is **0** when the section does not render (default-off,
or no qualifying pair).

---

## 7. Retrieval / candidate no-change proof

Rendering-only. The feature reads `result.pivots`/`result.support` (`role`, `path`,
`symbol`, `source`) and emits text; it never generates candidates, re-ranks, re-scores, or
reassigns roles, and does not mutate its inputs (asserted by test 10).

Deterministic retrieval eval — **byte-identical** to the committed/working baselines:

```
diff <tmp>/stage5_retrieval_eval_expanded.csv      results/…expanded.csv      → BYTE-IDENTICAL
diff <tmp>/stage5_retrieval_eval_cross_repo_30.csv  results/…cross_repo_30.csv → BYTE-IDENTICAL
```

Default behavior unchanged: the section is gated OFF unless
`VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS` is an explicit truthy value (`1/true/on/yes`).

---

## 8. Next recommendation

**A — offline validation is clean, so the next step is a tiny live A/B on sphinx-7462
only.**

Detection triggers exactly on sphinx and stays silent on seaborn/django/no-context; token
cost is small (~114 tokens) and bounded; default behavior and retrieval are unchanged. The
open question is purely behavioral — does the semantic reframing actually flip the agent's
confident rule-out into a co-edit? That can only be answered live.

> **M40 (proposed, NOT run here):** tiny live A/B on `sphinx-doc__sphinx-7462` only.
> - control = `VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS` off
> - treatment = on
> - no pivot revision, no verifier, no pivot-inspection enforcement
> - measure: secondary (`ast.py::unparse`) edited? resolved? token delta
> - canonical Docker eval after the protocol; sequential live runs; explicit approval required
>
> Honesty caveat (from M38): the agent's wrong rule-out was confident and source-grounded;
> the only mechanism that *proved* it could flip used the oracle. So M40 may show no behavior
> change even with the hypothesis. If treatment does not move the secondary-edit rate, the
> fallback is the gated revision branch — not more first-pass text.

---

## Appendix — files changed

- `src/capsuleV2/semanticEditHypothesis.ts` — new: builder + renderer + env gate + lexicon (PURE).
- `src/capsuleV2/semanticEditHypothesis.test.ts` — new: 15 tests (10 required cases + lexicon/flag).
- `src/capsuleV2/renderHuman.ts` — wire the section into the top advisory cluster, gated
  by `enableSemanticEditHypothesis` (default = env, default OFF).
- `benchmarks/stage5_vexp_swe_bench_smoke/m34_accounting.ts` — `semanticEditHypothesis`
  component + heading classifier + `semanticEditHypothesisTokens`/`Chars` fields.
- `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m34_accounting_and_functional_actionability.ts`
  — surface the new component in the uncounted-components report row.

Verification: `bun run typecheck` ✓, `bun run typecheck:benchmarks` ✓, `bun test` →
2945 pass / 0 fail, `git diff --check` clean, retrieval evals byte-identical.
</content>
