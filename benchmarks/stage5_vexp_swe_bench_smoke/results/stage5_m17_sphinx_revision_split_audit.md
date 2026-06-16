# Stage 5 — M17.1 audit: why sphinx r2's revised patch resolved but r1's did not

Diagnostic only (no new runs, no new mechanism). Inputs are the existing M16.1/M17 artifacts
for `eval-m16-ruleout-guard-current-sphinx-7462-r1` and `…-r2`. The two runs produced the
**same compliance verdict** and the **same gold `ast.py` hunk**, yet r2 resolves and r1 does
not. This audit pins the split to `sphinx/domains/python.py`.

## 1. Executive diagnosis

**Both revised patches contain the byte-identical gold `sphinx/pycode/ast.py::unparse` hunk
(empty `ast.Tuple` → `"()"`).** The difference is entirely in `sphinx/domains/python.py`,
the lead pivot:

- **r2 (resolved).** The revision **rewrote** the empty-`ast.Tuple` branch of
  `_parse_annotation` to actually **render `()`** (emit `(` and `)` punctuation nodes). Both
  FAIL_TO_PASS tests then pass.
- **r1 (no_effect).** The revision **left `python.py` byte-identical to the first pass** — it
  only added the `ast.py` hunk. The preserved first-pass `python.py` edit merely guards
  `result.pop()` with `if node.elts:` (preventing an `IndexError`) but **emits no `()` for an
  empty tuple**, so the annotation renders empty.

Root cause: the revision pass is **additive toward the flagged unclear/missing pivot**
(`ast.py`) and does **not re-verify or correct the lead-pivot edit** (`python.py`). r1's
preserved first-pass `python.py` is an insufficient fix for `test_parse_annotation`; r2 (by
stochastic luck of the second pass also touching `python.py`) rewrote it correctly. The
compliance signal — identical for both: `unclear[ast.py] → edited[ast.py]` — is blind to
whether the lead-pivot edit is *correct*, and `replacedFinalPatch` was `true` for both.

## 2. Artifact validity

All required artifacts present for both labels: canonical `swebench-*.jsonl`,
`_pivot_revision_original.patch`, `_pivot_revision_revised.patch`, `_pivot_revision.json`,
`_pivot_revision_shadow_eval.meta.json`, `_pivot_revision_shadow.jsonl`, revision prompt +
response, first-pass assistant text. Both shadow evals were **genuine**: `evaluationRan=true`,
`dockerUsed=true`, `evaluationError=null`, `canonicalArtifactsUntouched=true`. Per-test bucket
status is not exposed (the external evaluator writes only `resolved` into the row, no
`tests_status`), so `failToPassResult` is `unknown` in the metadata — the failing test is
inferred from patch shape (below), not read from a bucket.

## 3. Patch comparison table

| label | original resolved | shadow revised resolved | original patch files | revised patch files | ast.py hunk present? | python.py hunk present? | extra files? | classification |
|---|---|---|---|---|---|---|---|---|
| …sphinx-7462-r1 | False | **False** | python.py | python.py, ast.py | ✅ (gold, identical to r2) | ✅ but **insufficient** (guards `pop()`, no `()`) | none | **`revision_preserved_bad_first_pass`** |
| …sphinx-7462-r2 | False | **True** | python.py | python.py, ast.py | ✅ (gold) | ✅ **renders `()`** | none | `shadow_resolution_success` |

Hashes (sha256-16, from shadow metadata): r1 original `ec96de0e3a8ae856` → revised
`b4032c35647c3b62`; r2 original `6aca9946519543a6` → revised `f2362cbd9bc4b33d`. Verified:
r1 revised `python.py` == r1 original `python.py` (preserved); r2 revised `python.py` !=
r2 original `python.py` (rewritten).

## 4. Hunk-level notes

- **ast.py (both, identical):** empty-tuple branch changes
  `return ", ".join(unparse(e) for e in node.elts)` →
  `if node.elts: return ", ".join(...) else: return "()"`. Correct gold fix; satisfies
  `test_unparse[()-()]`.
- **python.py — r1 (preserved first pass):** two hunks change `result.pop()` →
  `if node.elts: result.pop()`. This only prevents the empty-tuple `IndexError`; the empty
  tuple still produces an **empty** node list (no `(`/`)` punctuation). Insufficient for
  `test_parse_annotation`.
- **python.py — r2 (rewritten):** the empty-`ast.Tuple` branch becomes
  `if node.elts: <build comma-joined list> else: return [desc_sig_punctuation('', '('),
  desc_sig_punctuation('', ')')]` — i.e. it **renders `()`**. Satisfies
  `test_parse_annotation`.

## 5. Evaluation failure analysis (r1)

FAIL_TO_PASS = `tests/test_domain_py.py::test_parse_annotation` (exercises
`python.py::_parse_annotation`) and `tests/test_pycode_ast.py::test_unparse[()-()]`
(exercises `ast.py::unparse`). Resolution requires **both**.

- `test_unparse[()-()]` — **passes** in r1 (correct ast.py hunk).
- `test_parse_annotation` — **fails** in r1: the preserved `python.py` edit renders an empty
  annotation instead of `()`.

This is a **real patch reason**, not an eval/infra artifact: the shadow eval ran cleanly
(no error, canonical untouched), the ast.py and python.py hunks apply to the right functions,
and the failure follows deterministically from the insufficient `python.py` edit. Not a patch
application issue, not an unrelated test, not stochastic eval noise.

## 6. Wiring recommendation

**A — implement a replacement guardrail before any canonical wiring.** r1 demonstrates that
**compliance improvement is not a sufficient adoption signal**: r1 and r2 had identical
compliance verdicts (`edited[ast.py]`) and both set `replacedFinalPatch=true`, yet only r2's
underlying patch resolves. Before revised patches go anywhere near canonical evaluation, the
replacement decision must be gated on **actual resolution** (e.g. the M17 read-only shadow
eval, or an equivalent verification step) rather than on compliance alone — adopt the revised
patch only when its shadow eval resolves. A secondary improvement is to make the revision pass
**re-verify the lead-pivot edit** (here `python.py::_parse_annotation`) against FAIL_TO_PASS,
not just additively edit the flagged unclear/missing pivot; the current pass scopes itself to
the flagged pivot and trusts the first-pass lead edit, which r1 shows can be wrong.

Not recommended yet: wiring revised patches into canonical evaluation, making revision
default, or any 30/100 sweep.

---

*This is a patch-shape + replacement-policy finding, not an eval artifact. The revision chain
can produce a resolving patch (r2), but the adoption/replacement policy currently cannot tell
r2's correct patch from r1's still-broken one. Fix the gate before the wiring.*
