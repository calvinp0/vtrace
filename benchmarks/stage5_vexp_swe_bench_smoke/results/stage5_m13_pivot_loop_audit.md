# Stage 5 M13 — Pivot-inspection compliance audit (Option B)

Offline audit of the M13 structured pivot-inspection compliance checker (`computePivotInspectionCompliance` in `src/capsuleV2/pivotInspectionCompliance.ts`). **Diagnostic only** — no live agents, no Docker, no 30/100-case runs, no retrieval/scoring/ranking/candidate-gen/pivot-selection change (retrieval evals byte-identical). It audits the ALREADY-captured M12.1 enforcement runs.

**Implementation: Option B (finalize-time static check).** The checker produces a deterministic verdict AND the corrective-prompt text, but does NOT send a live corrective turn: the external SWE-bench harness owns the turn loop and final-patch extraction, so Option A (mid-run re-prompt) would require modifying that external harness — too invasive. Option C's machine-readable `PIVOT_DECISION` parser is included so a future marker-emitting run can drive `ruledOut`; the off-by-default enforcement block is unchanged, so these captured runs carry no markers.

**Conservative classification.** Model prose is NOT persisted in the run artifacts (only the final patch + ordered tool calls + the manifest). So an explicit source-grounded rule-out can only be observed via a `PIVOT_DECISION` marker. With no marker: a candidate whose file is in the patch is `edited`; one that was inspected but not edited is `unclear` (cannot confirm a grounded rule-out); one never inspected and never edited is `missing`. `unclear` and `missing` both fire the corrective prompt.

Compliance is measured on pivot HANDLING, not task resolution — a run can resolve while leaving a non-gold non-lead pivot `unclear`, and can be fully compliant while still unresolved.

## Per-run result

| case | run | resolved | required | edited | ruled-out | missing | unclear | corrective fires? | risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sphinx-7462 | `…sphinx-7462-r1` | no | `sphinx/pycode/ast.py::unparse` | — | — | — | `sphinx/pycode/ast.py::unparse` | yes | medium — inspected but no source-grounded rule-out marker captured (prose not persisted) |
| sphinx-7462 | `…sphinx-7462-r2` | no | `sphinx/pycode/ast.py::unparse` | — | — | — | `sphinx/pycode/ast.py::unparse` | yes | medium — inspected but no source-grounded rule-out marker captured (prose not persisted) |
| sphinx-7462 | `…sphinx-7462-r3` | no | `sphinx/pycode/ast.py::unparse` | — | — | `sphinx/pycode/ast.py::unparse` | — | yes | HIGH — a required pivot was never inspected (true skip) |
| seaborn-3187 | `…seaborn-3187-r1` | no | `seaborn/relational.py::scatterplot` | — | — | — | `seaborn/relational.py::scatterplot` | yes | medium — inspected but no source-grounded rule-out marker captured (prose not persisted) |
| seaborn-3187 | `…seaborn-3187-r2` | no | `seaborn/relational.py::scatterplot` | — | — | — | `seaborn/relational.py::scatterplot` | yes | medium — inspected but no source-grounded rule-out marker captured (prose not persisted) |
| seaborn-3187 | `…seaborn-3187-r3` | yes | `seaborn/relational.py::scatterplot` | — | — | — | `seaborn/relational.py::scatterplot` | yes | medium — inspected but no source-grounded rule-out marker captured (prose not persisted) |
| django-13195 | `…django-13195-r1` | no | `django/http/response.py::set_cookie`, `django/contrib/sessions/middleware.py (co-edit)`, `django/contrib/messages/storage/cookie.py (co-edit)` | `django/http/response.py::set_cookie`, `django/contrib/sessions/middleware.py`, `django/contrib/messages/storage/cookie.py` | — | — | — | no | none — every required candidate edited or grounded-ruled-out |
| django-13195 | `…django-13195-r2` | no | `django/http/response.py::set_cookie`, `django/contrib/sessions/middleware.py (co-edit)`, `django/contrib/messages/storage/cookie.py (co-edit)` | `django/http/response.py::set_cookie`, `django/contrib/sessions/middleware.py`, `django/contrib/messages/storage/cookie.py` | — | — | — | no | none — every required candidate edited or grounded-ruled-out |
| django-13195 | `…django-13195-r3` | no | `django/http/response.py::set_cookie`, `django/contrib/sessions/middleware.py (co-edit)`, `django/contrib/messages/storage/cookie.py (co-edit)` | `django/http/response.py::set_cookie`, `django/contrib/sessions/middleware.py`, `django/contrib/messages/storage/cookie.py` | — | — | — | no | none — every required candidate edited or grounded-ruled-out |

## Per-run corrective-prompt content

### eval-m12-pivot-enforcement-current-sphinx-7462-r1
- reads gold ast.py, edits only python.py
- required: `sphinx/pycode/ast.py::unparse`
- expected corrective prompt: lists 1 outstanding: `sphinx/pycode/ast.py::unparse` (inspect/edit-or-rule-out; minimal diff; cite source)

```text
You have not completed the required pivot check.

Missing:
  - sphinx/pycode/ast.py::unparse

Before finalizing, inspect/edit or explicitly rule out each missing pivot with source-grounded evidence.
Do not add files merely because they are listed. Inspect it and decide.
Prefer the minimal diff.
If you rule it out, cite concrete source evidence.
```

### eval-m12-pivot-enforcement-current-sphinx-7462-r2
- reads gold ast.py, edits only python.py
- required: `sphinx/pycode/ast.py::unparse`
- expected corrective prompt: lists 1 outstanding: `sphinx/pycode/ast.py::unparse` (inspect/edit-or-rule-out; minimal diff; cite source)

```text
You have not completed the required pivot check.

Missing:
  - sphinx/pycode/ast.py::unparse

Before finalizing, inspect/edit or explicitly rule out each missing pivot with source-grounded evidence.
Do not add files merely because they are listed. Inspect it and decide.
Prefer the minimal diff.
If you rule it out, cite concrete source evidence.
```

### eval-m12-pivot-enforcement-current-sphinx-7462-r3
- never inspects ast.py, edits only python.py
- required: `sphinx/pycode/ast.py::unparse`
- expected corrective prompt: lists 1 outstanding: `sphinx/pycode/ast.py::unparse` (inspect/edit-or-rule-out; minimal diff; cite source)

```text
You have not completed the required pivot check.

Missing:
  - sphinx/pycode/ast.py::unparse

Before finalizing, inspect/edit or explicitly rule out each missing pivot with source-grounded evidence.
Do not add files merely because they are listed. Inspect it and decide.
Prefer the minimal diff.
If you rule it out, cite concrete source evidence.
```

### eval-m12-pivot-enforcement-current-seaborn-3187-r1
- edits scales.py + utils.py
- required: `seaborn/relational.py::scatterplot`
- expected corrective prompt: lists 1 outstanding: `seaborn/relational.py::scatterplot` (inspect/edit-or-rule-out; minimal diff; cite source)

```text
You have not completed the required pivot check.

Missing:
  - seaborn/relational.py::scatterplot

Before finalizing, inspect/edit or explicitly rule out each missing pivot with source-grounded evidence.
Do not add files merely because they are listed. Inspect it and decide.
Prefer the minimal diff.
If you rule it out, cite concrete source evidence.
```

### eval-m12-pivot-enforcement-current-seaborn-3187-r2
- under-edits: scales.py only
- required: `seaborn/relational.py::scatterplot`
- expected corrective prompt: lists 1 outstanding: `seaborn/relational.py::scatterplot` (inspect/edit-or-rule-out; minimal diff; cite source)

```text
You have not completed the required pivot check.

Missing:
  - seaborn/relational.py::scatterplot

Before finalizing, inspect/edit or explicitly rule out each missing pivot with source-grounded evidence.
Do not add files merely because they are listed. Inspect it and decide.
Prefer the minimal diff.
If you rule it out, cite concrete source evidence.
```

### eval-m12-pivot-enforcement-current-seaborn-3187-r3
- resolved: scales.py + utils.py
- required: `seaborn/relational.py::scatterplot`
- expected corrective prompt: lists 1 outstanding: `seaborn/relational.py::scatterplot` (inspect/edit-or-rule-out; minimal diff; cite source)

```text
You have not completed the required pivot check.

Missing:
  - seaborn/relational.py::scatterplot

Before finalizing, inspect/edit or explicitly rule out each missing pivot with source-grounded evidence.
Do not add files merely because they are listed. Inspect it and decide.
Prefer the minimal diff.
If you rule it out, cite concrete source evidence.
```

### eval-m12-pivot-enforcement-current-django-13195-r1
- edits response.py + middleware.py + cookie.py
- required: `django/http/response.py::set_cookie`, `django/contrib/sessions/middleware.py (co-edit)`, `django/contrib/messages/storage/cookie.py (co-edit)`
- expected corrective prompt: no prompt (fully compliant)

### eval-m12-pivot-enforcement-current-django-13195-r2
- edits response.py + middleware.py + cookie.py
- required: `django/http/response.py::set_cookie`, `django/contrib/sessions/middleware.py (co-edit)`, `django/contrib/messages/storage/cookie.py (co-edit)`
- expected corrective prompt: no prompt (fully compliant)

### eval-m12-pivot-enforcement-current-django-13195-r3
- edits response.py + middleware.py + cookie.py
- required: `django/http/response.py::set_cookie`, `django/contrib/sessions/middleware.py (co-edit)`, `django/contrib/messages/storage/cookie.py (co-edit)`
- expected corrective prompt: no prompt (fully compliant)

## Which labels would trigger a corrective prompt

- **would fire** (6): `eval-m12-pivot-enforcement-current-sphinx-7462-r1`, `eval-m12-pivot-enforcement-current-sphinx-7462-r2`, `eval-m12-pivot-enforcement-current-sphinx-7462-r3`, `eval-m12-pivot-enforcement-current-seaborn-3187-r1`, `eval-m12-pivot-enforcement-current-seaborn-3187-r2`, `eval-m12-pivot-enforcement-current-seaborn-3187-r3`
- **compliant, no prompt** (3): `eval-m12-pivot-enforcement-current-django-13195-r1`, `eval-m12-pivot-enforcement-current-django-13195-r2`, `eval-m12-pivot-enforcement-current-django-13195-r3`

## Findings vs M13 expectations

| case | expectation | result |
| --- | --- | --- |
| sphinx-7462 | gold `ast.py` is edited nowhere → all runs fire a corrective prompt | ✅ |
| sphinx-7462 | runs that read `ast.py` mark it `unclear`; the run that never reads it marks it `missing` | ✅ |
| seaborn-3187 | under-edited run leaves a non-lead pivot outstanding (fires) | ✅ |
| django-13195 | all gold/co-edit files edited → fully compliant, no prompt | ✅ |

## Notable divergence

seaborn-3187-r3 RESOLVED yet the checker reports its non-lead pivot `seaborn/relational.py::scatterplot` as `unclear` (the gold fix is `scales.py` + `utils.py`; `relational.py` is a surfaced non-lead pivot the agent inspected and correctly did not edit). Under the conservative model this is `unclear`, not compliant, because no source-grounded rule-out is observable in the captured artifacts. This is the expected cost of Option B without marker emission: it cannot distinguish a correct silent rule-out from an oversight. The fix is Option C marker emission (parser already shipped), which would let r3 record a grounded `RULED_OUT` for `relational.py` and become fully compliant — the next implementation step, gated behind the same opt-in flag.

## Non-claims
- No live agents and no Docker were run; this is a deterministic post-hoc audit.
- The checker is Option B: it computes a verdict + corrective-prompt text; it does NOT re-prompt a live agent.
- Model prose is not persisted, so source-grounded rule-outs are not observable here; `unclear` is the conservative verdict for inspected-but-not-edited pivots.
- Off by default (`--pivot-inspection-enforcement` opt-in); the legacy PIVOT_CHECK policy and `--disable-pivot-check` are untouched.
- No retrieval/scoring/ranking/candidate-gen/pivot-selection change.
