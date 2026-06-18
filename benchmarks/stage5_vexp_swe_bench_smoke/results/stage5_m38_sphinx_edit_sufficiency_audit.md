# M38 — sphinx-7462 edit-sufficiency audit

**Instance:** `sphinx-doc__sphinx-7462` — `IndexError: pop from empty list` for empty
tuple type annotation (`Tuple[()]`).

**Gold patch edits two files (both required by FAIL_TO_PASS):**

| File | Symbol | Change | FAIL_TO_PASS test |
|------|--------|--------|-------------------|
| `sphinx/domains/python.py` | nested `unparse` in `_parse_annotation` | guard `result.pop()` on empty `ast.Tuple`/`ast.List` | `tests/test_domain_py.py::test_parse_annotation` |
| `sphinx/pycode/ast.py` | module-level `unparse` | empty `ast.Tuple` → return `"()"` (was `", ".join(...)` → `""`) | `tests/test_pycode_ast.py::test_unparse[()-()]` |

Resolution requires **both** tests to pass. Every captured run edits only `python.py`
and is therefore `resolved=0`.

**Mode:** offline only. No live agents, no Docker, no canonical SWE-bench evaluation,
no retrieval/ranking/scoring changes. Report-only (no source changed).

---

## 1. Executive verdict

**Why did `ast.py::unparse` remain unedited?**

Not retrieval, not salience, not co-edit reach, and **not a missing obligation**.
`sphinx/pycode/ast.py::unparse` is surfaced as **pivot #2 in every captured run**
(M10 → M36), with its full source inlined and an explicit co-edit / "edit-or-rule-out"
obligation attached. The agent reads it and then **explicitly and confidently rules it
out** — with the *same source-grounded-but-wrong reason in every run*:

> "`sphinx/pycode/ast.py::unparse` uses `", ".join()` which safely returns an empty
> string for empty iterables — no `pop()` call, so no fix needed there. The co-edit
> candidate is ruled out."

The agent frames the bug as **the crash symptom** (`IndexError` from `result.pop()`)
rather than the **required behavior** (an empty tuple `Tuple[()]` must *render as* `()`).
`", ".join([])` does not crash — but it returns `""`, which is wrong output. The gold
patch makes `ast.py` return `"()"`; the FAIL_TO_PASS test `test_unparse[()-()]` asserts
exactly that. The agent never reasons about output correctness, only crash-avoidance, so
"no `pop()` → no fix" looks airtight to it.

This is a **`seen_but_deemed_unnecessary`** failure, driven by **traceback/symptom-anchored
bug framing**. The obligation machinery works *procedurally* — the agent inspects and
supplies a source-grounded rule-out — but the rule-out's premise is wrong.

**Is the next fix generic wording, semantic hypothesis, test feedback, or something else?**

**Semantic edit hypothesis (option B).** Generic obligation wording is the *wrong lever*:
the runs already carry the M11 pivot-inspection contract, the M35 multi-pivot action plan,
the "multiple edit targets" block, and a co-edit checklist — five overlapping obligation
blocks — and the agent satisfies all of them by ruling out. More obligation text produces
more confident rule-outs, not edits. The only signal that can flip the decision is one
that attacks the faulty premise directly: a hypothesis that reframes the bug as
*output correctness across both `unparse` implementations* and explicitly warns that
"does not crash" is not evidence of "is correct."

**Caveat (important):** the *only* mechanism that ever produced the `ast.py` edit — the
M14/M15/M16 pivot-revision second pass — succeeded **by leaking the oracle**: its prompt
shows the agent `tests/test_pycode_ast.py::test_unparse[()-()]` by name. That is precisely
the oracle/test-label mechanism the task forbids for first-pass. So a fair, non-oracle
first-pass fix has *no proven precedent* here; option B is the best-supported bet, but its
effectiveness against a confident first-pass rule-out is plausible-but-unproven.

---

## 2. Evidence by run

`ast surfaced?` = present in capsule manifest/pivot list/context. `ast read?` = a Read
tool call touched `pycode/ast.py` (grep-only counted separately). `ast mentioned?` = named
in agent reasoning/PIVOT_DECISION. `ast ruled out?` = explicit rule-out statement.
`ast edited?` = present in the **canonical** modelPatch.

| label | arm / milestone | ast surfaced | ast read | ast mentioned | ast ruled out | ast edited (canonical) | resolved | classification |
|-------|-----------------|:---:|:---:|:---:|:---:|:---:|:---:|----------------|
| eval-m32-product-vtrace-…-r1 | plain VTRACE | Y | Y | Y | Y (explicit) | N | N | seen_but_deemed_unnecessary |
| eval-m32-product-vtrace-…-r2 | plain VTRACE | Y | grep only | Y | Y | N | N | seen_but_deemed_unnecessary |
| eval-m32-product-vtrace-…-r3 | plain VTRACE | Y | N | Y | Y | N | N | seen_but_deemed_unnecessary |
| eval-m32-product-baseline-…-r1–r3 | no-context baseline | N (no capsule) | N | N | — | N | not eval'd | not_seen (no-context arm) |
| eval-m36-control-…-r1 | M36 control (no action plan) | Y | Y | Y | Y (explicit) | N | N | seen_but_deemed_unnecessary |
| eval-m36-control-…-r2 | M36 control | Y | N | Y | Y | N | N | seen_but_deemed_unnecessary |
| eval-m36-control-…-r3 | M36 control | Y | grep only | Y | Y | N | N | seen_but_deemed_unnecessary |
| eval-m36-treatment-…-r1 | M36 treatment (M35 action plan) | Y | grep only | Y | Y (explicit) | N | N | seen_but_deemed_unnecessary |
| eval-m36-treatment-…-r2 | M36 treatment | Y | Y | Y | Y | N | N | seen_but_deemed_unnecessary |
| eval-m36-treatment-…-r3 | M36 treatment | Y | Y | Y | Y | N | N | seen_but_deemed_unnecessary |
| eval-m14-pivot-revision-…-r1–r3 | M14 revision pass | Y | mixed | Y (PIVOT_DECISION RULED_OUT) | Y | N canonical / **revision patch edits ast** | N | seen_but_deemed_unnecessary (first pass) |
| eval-m15-pivot-revision-…-r1,r2 | M15 revision pass | Y | mixed | Y | Y | N canonical / revision patch edits ast | N | seen_but_deemed_unnecessary |
| eval-m16-ruleout-guard-…-r1 | M16 rule-out guard + shadow eval | Y | Y | Y (RULED_OUT) | Y | N canonical / revision patch edits ast | N (shadow `shadow_no_effect`) | seen_but_deemed_unnecessary |
| eval-m16-ruleout-guard-…-r2 | M16 rule-out guard + shadow eval | Y | Y | Y (RULED_OUT) | Y | N canonical / **revision patch edits ast → shadow `shadow_resolution_success`, resolved=1** | N canonical / **Y shadow** | seen_but_deemed_unnecessary (first pass); revision recovers |

**Aggregate:** `ast.py::unparse` surfaced in **24/24** capsule runs; **canonically edited
in 0/24**; explicitly ruled out in every run that left reasoning text. Canonical
`resolved=0` in all. The single resolution anywhere in the corpus is M16-r2's **non-canonical
shadow eval** of the oracle-prompted revision patch.

---

## 3. Mechanism comparison

| # | Mechanism | What it adds | ast.py edited? | Resolved? | Fair / first-pass / non-oracle? |
|---|-----------|--------------|:---:|:---:|---|
| 1 | **Plain VTRACE** (M32) | pivot list w/ `ast.py::unparse` as pivot #2, full source inlined, "hidden candidate" note, pivot-inspection contract, co-edit obligation | No | No (0/3) | Yes — but insufficient |
| 2 | **M35 multi-pivot action plan** (M36 treatment) | adds "Multi-Pivot Action Plan / Required inspection set / edit-it-or-rule-it-out" *on top of* #1 | No | No (0/3) | Yes — but **zero marginal effect**: M36 control (no action plan) behaves identically; same rule-out, same patch |
| 3 | **Pivot-revision / rule-out guard** (M14/M15/M16) | a corrective **second pass** that re-confronts the agent with the missing pivot | **Yes** (in the non-canonical `_pivot_revision_revised.patch`) | **Yes, once** (M16-r2 shadow `shadow_resolution_success`) | **No** — second pass (not first-pass), non-canonical (does not replace canonical patch), and **the prompt leaks FAIL_TO_PASS test names** (`test_unparse[()-()]`) as an oracle |

**Which mechanism actually caused ast.py to be edited?** Only #3, the revision pass — and
only in its non-canonical revised patch. M16-r2 proves the edit is *correct and sufficient*:
the revised patch adds exactly the gold `ast.Tuple → "()"` hunk and the shadow eval
resolves the instance.

**Was that mechanism fair / product-like?** No. It is a gated second pass, and it works
because its prompt shows the agent the FAIL_TO_PASS test labels — including
`tests/test_pycode_ast.py::test_unparse[()-()]`, which names the empty-tuple case in the
`ast.py` test file. That is oracle leakage, explicitly out of scope.

**Can any part be brought into first-pass rendering without revision/enforcement?** The
*reframing* can, but not the oracle. Strip the test labels and what remains is: "two
pivots are implementations of the same `unparse` operation; the second may avoid the crash
yet still produce wrong output; verify output, don't just check for the crash." That
content is derivable from first-pass, non-oracle context (see §5).

---

## 4. Root cause

**Dominant cause: `seen_but_deemed_unnecessary` — confident, source-grounded but wrong
first-pass rule-out, caused by symptom-anchored bug framing.**

- `not_seen` — rejected. ast.py is surfaced and (often) read in every capsule run.
- `seen_but_unlinked` — rejected. The agent explicitly *links* ast.py to the task (it is
  "the other `unparse`") and then dismisses it.
- `seen_but_no_edit_instruction` — rejected. Five overlapping obligation blocks demand
  edit-or-rule-out; the agent obeys by ruling out.
- `seen_but_patch_synthesis_uncertain` — rejected. The agent knows exactly what the empty
  case is; it simply concludes (wrongly) that `join()` already handles it.
- `test_feedback_missing` — contributing but secondary. The agent's verification attempts
  hit unrelated import errors (Jinja2) and never actually exercise `test_unparse[()-()]`,
  so nothing contradicts its rule-out. Real first-pass test feedback *could* break the
  loop — but the fair/non-oracle version of that is hard (the agent must independently
  discover and run the `ast.py` unparse test), so this is a weaker lever than B.

The defect is a single faulty inference, repeated identically across runs:
**"does not crash" ⇒ "is correct" ⇒ "no fix needed."**

---

## 5. Recommended first-pass improvement

**Chosen: B — semantic edit hypothesis for paired (same-symbol) pivots.**

Not A (stronger obligation wording): obligation is already saturated and the agent
complies with it by ruling out — more obligation text yields more confident rule-outs.
Not C (generic checklist): the agent ticks "ruled out." Not D (test discovery): the only
working version leaks the oracle; a fair version is high-effort and unproven. B is the one
lever aimed squarely at the faulty premise.

The hypothesis must be **non-oracle and context-derived**. The signals it is built from are
all present at first pass, with no FAIL_TO_PASS / gold-patch knowledge:

1. **two pivots share the same symbol name** (`unparse`) across different modules — the
   manifest already records this as a "symbol-name match" reason;
2. both pivots **contain a branch on the same AST node type** (`ast.Tuple`) — visible in
   the already-inlined source;
3. the issue's **triggering input is an empty tuple** (`Tuple[()]`, "empty tuple") — issue text.

Proposed rendering (semantic, not generic):

```
Paired-symbol hypothesis (same operation, two implementations):
  sphinx/domains/python.py::unparse  and  sphinx/pycode/ast.py::unparse
  are two implementations of the same operation. Both branch on ast.Tuple,
  and the triggering input is an empty tuple.
  A change that makes the empty-tuple case correct in one is very likely
  required in the other.
  CAUTION: the second implementation may NOT crash on this input yet still
  produce wrong output (e.g. "" instead of "()"). Do not rule it out merely
  because it avoids the error — confirm it produces the correct result for
  the empty-tuple input, then edit or rule out on that basis.
```

The final clause is the active ingredient: it directly negates the observed rule-out
("no `pop()`, no crash, no fix") by separating *crash-avoidance* from *output correctness*.

**Honesty about expected efficacy:** the agent's wrong rule-out was confident and
source-grounded. B raises the odds the agent re-checks output rather than the crash, but
there is no first-pass precedent proving it overrides a confident inference (the only proof
we have used the oracle). Treat B as a well-targeted hypothesis to test offline, not a
guaranteed fix. If B fails offline, the proven-but-gated fallback is the revision branch
(§6 risk).

---

## 6. Implementation proposal — M39 (next milestone, NOT implemented here)

**M39: paired-symbol semantic edit hypothesis for same-name multi-module pivots.**

Scope (first-pass, non-oracle, off by default behind a flag):

1. In Capsule v2 rendering, detect when **≥2 surfaced pivots share a normalized symbol
   name** in different files (data already in the manifest — `symbol-name match` is an
   existing surfacing reason). Start with the strict same-name case to bound false positives.
2. Optionally tighten with a cheap structural check: both pivots' inlined source contain a
   branch keyed on the **same node/type token** mentioned in the issue (here `ast.Tuple`;
   issue says "empty tuple"). Purely lexical over already-captured source — no new indexing,
   no graph traversal, no oracle.
3. Emit one compact "paired-symbol hypothesis" block (rendering in §5), replacing nothing —
   additive to the existing co-edit obligation. Keep it ≤ ~6 lines.
4. Gate behind a flag (e.g. `--paired-symbol-hypothesis` / `enablePairedSymbolHypothesis`),
   **off by default**, mirroring the M7.3 traceback-skip pattern (detector + diagnostics
   always on; behavior change opt-in).
5. Validate **offline** on the captured sphinx-7462 artifacts first (does the block render
   for the `unparse`/`unparse` pair? does it stay silent on single-pivot cases like the
   astropy/django smoke set?). Live A/B only with explicit approval, sequential, after the
   offline render check.
6. Prove **retrieval/ranking/scoring byte-identical** (the deterministic no-change proof in
   CLAUDE.md) — this milestone touches rendering only, never candidate generation or ranking.

Non-goals carried forward: do not enable pivot revision by default; do not surface
FAIL_TO_PASS / test labels; do not productize; do not tune retrieval.

---

## 7. Risks

- **Token cost.** One ≤6-line block per qualifying task. Negligible per-task; only fires
  when ≥2 same-name pivots exist, which is rare. Bounded by capping to the single
  top same-name pair.
- **Over-edit / false positives.** The real danger: telling the agent "the paired symbol
  probably needs the same change" can induce spurious co-edits when the second
  implementation genuinely differs (different semantics behind the same name). Two same-name
  `unparse` functions sharing an `ast.Tuple` branch is a strong pair; "same name, unrelated
  behavior" is a weak pair. Mitigations: require the structural token match (step 2), keep
  the wording as *hypothesis + verify-output* (not a directive to edit), keep it gated off
  by default, and measure the no-regression set offline before any live A/B.
- **Compliance theater.** As with the existing obligation blocks, the agent may "verify
  output" superficially and still rule out. This is why efficacy is unproven; the block is
  worth testing precisely because it targets the faulty premise, but it may not survive a
  confident model.
- **Oracle temptation.** The historically *effective* mechanism leaked test labels. M39
  must resist re-introducing that under the banner of "test feedback"; any test-discovery
  variant must derive tests without FAIL_TO_PASS knowledge.

---

## Appendix — provenance

- Gold patch / FAIL_TO_PASS: `vexp-swe-bench/data/swe-bench-100.jsonl`,
  instance `sphinx-doc__sphinx-7462`.
- Per-run signals extracted from `runs/<label>/raw/vtrace/`: `_capsule_v2_manifest.json`,
  `_capsule_v2_context.md`, `_tool_calls.json`, `swebench-*.jsonl`, `_eval.meta.json`,
  `_agent_stream.first_pass.jsonl`, and (M14–M16) `_pivot_first_pass_assistant.txt`,
  `_pivot_revision_prompt.md`, `_pivot_revision_revised.patch`,
  `_pivot_revision_shadow_eval.meta.json`.
- M16-r2 shadow eval: `classification: shadow_resolution_success`, `resolved: true`,
  `canonicalArtifactsUntouched: true` — the revised (oracle-prompted) patch resolves; the
  canonical patch is unchanged and stays `resolved=0`.
</content>
</invoke>
