# Stage 5 M12 — Pivot-check enforcement audit

Offline audit of the M12 narrow pivot-check enforcement mode (`--pivot-inspection-enforcement`; renderer `renderPivotInspectionEnforcementText` in `src/capsuleV2/pivotInspectionContract.ts`, injected by the Stage 5 runner BEFORE the capsule body). **Diagnostic only** — no live agents, no Docker, no 30/100-case runs, no retrieval/scoring/ranking/candidate-gen change (retrieval evals byte-identical; this is render-only). The enforcement block is built from the same pivot inspection contract the M11 advisory uses; it adds an explicit EDITED / RULED-OUT decision demand per non-lead pivot + co-edit candidate with anti-over-edit guardrails.

Each case rebuilt with current code from a captured `.vtrace/index.sqlite` (task replayed from `_run.meta.json`). Enforcement is simulated as ENABLED for the audit; by default the mode is OFF and only the M11 advisory renders.

## Per-case result

| case | contract? | enf. enabled | enf. rendered | non-lead pivots | co-edit candidates | anti-over-edit | gen-artifact preserved | before bodies | before 12k | expected live effect | risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **sphinx-7462** | yes | yes | yes | `sphinx/pycode/ast.py::unparse` | — | yes | yes | yes | yes | forces an explicit EDITED/RULED-OUT decision for the non-lead pivot; anti-over-edit guardrail keeps the diff minimal | low — basic edit-or-rule-out demand on real pivots |
| **seaborn-3187** | yes | yes | yes | `seaborn/relational.py::scatterplot` | — | yes | yes | yes | yes | forces an explicit EDITED/RULED-OUT decision for the non-lead pivot; anti-over-edit guardrail keeps the diff minimal | low — basic edit-or-rule-out demand on real pivots |
| **django-13195** | yes | yes | yes | `django/http/response.py::set_cookie` | `django/contrib/sessions/middleware.py`, `django/contrib/messages/storage/cookie.py` | yes | yes | yes | yes | forces an explicit EDITED/RULED-OUT decision for each non-lead pivot + co-edit candidate; anti-over-edit guardrail discourages padding the diff | medium — co-edit coupling is inferred; guardrail mitigates over-edit |
| **astropy-14369** (ctl) | yes | yes | yes | `astropy/units/format/cds.py::to_string` | — | yes | yes | yes | yes | forces an explicit EDITED/RULED-OUT decision for the non-lead pivot; anti-over-edit guardrail keeps the diff minimal | low — basic edit-or-rule-out demand on real pivots |
| **sympy-16766** (ctl) | yes | yes | yes | `sympy/printing/printer.py::_print` | — | yes | yes | yes | yes | forces an explicit EDITED/RULED-OUT decision for the non-lead pivot; anti-over-edit guardrail keeps the diff minimal | low — basic edit-or-rule-out demand on real pivots |
| **requests-5414** (ctl) | yes | yes | yes | `requests/api.py::get` | — | yes | yes | yes | yes | forces an explicit EDITED/RULED-OUT decision for the non-lead pivot; anti-over-edit guardrail keeps the diff minimal | low — basic edit-or-rule-out demand on real pivots |

## Per-case detail

### sphinx-7462
- non-lead gold ast.py read 3/3 but never edited under M11 advisory
- pivots: 2; lead `sphinx/domains/python.py::_parse_annotation`
- non-lead pivots (edit-or-rule-out): `sphinx/pycode/ast.py::unparse`
- co-edit candidates: —
- enforcement rendered: yes; anti-over-edit wording: yes
- generated-artifact hints preserved: yes; generated tables mislabeled as co-edit: no
- position: marker at char 0 (before bodies: yes; before 12k: yes)

### seaborn-3187
- M11 resolved 2/3 but r1 over-edited — needs anti-over-edit guardrail
- pivots: 2; lead `seaborn/_core/scales.py::_setup`
- non-lead pivots (edit-or-rule-out): `seaborn/relational.py::scatterplot`
- co-edit candidates: —
- enforcement rendered: yes; anti-over-edit wording: yes
- generated-artifact hints preserved: yes; generated tables mislabeled as co-edit: no
- position: marker at char 0 (before bodies: yes; before 12k: yes)

### django-13195
- all-gold already 3/3 under M11; must not regress
- pivots: 2; lead `django/http/response.py::delete_cookie`
- non-lead pivots (edit-or-rule-out): `django/http/response.py::set_cookie`
- co-edit candidates: `django/contrib/sessions/middleware.py`, `django/contrib/messages/storage/cookie.py`
- enforcement rendered: yes; anti-over-edit wording: yes
- generated-artifact hints preserved: yes; generated tables mislabeled as co-edit: no
- position: marker at char 0 (before bodies: yes; before 12k: yes)

### astropy-14369 (control)
- generated-artifact (PLY parser table) case
- pivots: 2; lead `astropy/units/format/vounit.py::VOUnit`
- non-lead pivots (edit-or-rule-out): `astropy/units/format/cds.py::to_string`
- co-edit candidates: —
- enforcement rendered: yes; anti-over-edit wording: yes
- generated-artifact hints preserved: yes; generated tables mislabeled as co-edit: no
- position: marker at char 0 (before bodies: yes; before 12k: yes)

### sympy-16766 (control)
- single-module multi-pivot fix
- pivots: 2; lead `sympy/printing/pycode.py::PythonCodePrinter`
- non-lead pivots (edit-or-rule-out): `sympy/printing/printer.py::_print`
- co-edit candidates: —
- enforcement rendered: yes; anti-over-edit wording: yes
- generated-artifact hints preserved: yes; generated tables mislabeled as co-edit: no
- position: marker at char 0 (before bodies: yes; before 12k: yes)

### requests-5414 (control)
- patch-synthesis-bound; no cross-module co-edit
- pivots: 2; lead `requests/models.py::prepare_url`
- non-lead pivots (edit-or-rule-out): `requests/api.py::get`
- co-edit candidates: —
- enforcement rendered: yes; anti-over-edit wording: yes
- generated-artifact hints preserved: yes; generated tables mislabeled as co-edit: no
- position: marker at char 0 (before bodies: yes; before 12k: yes)

## Success criteria

| # | criterion | result |
| --- | --- | --- |
| 1 | sphinx-7462 enforcement lists `ast.py::unparse` as edit-or-rule-out | ✅ |
| 2 | seaborn-3187 enforcement renders with anti-over-edit wording | ✅ |
| 3 | django-13195 enforcement lists co-edit candidates (middleware/cookie) | ✅ |
| 4 | astropy-14369 generated-artifact hints preserved; tables not mislabeled | ✅ |
| 5 | sympy-16766 no noisy co-edit obligation | ✅ |
| 6 | requests-5414 no noisy co-edit obligation | ✅ |
| 7 | enforcement renders before pivot bodies and the 12k cutoff (all rendered cases) | ✅ |
| 8 | anti-over-edit guardrail present on every rendered block | ✅ |

## Non-claims
- No live agents and no Docker were run; this is a deterministic render-time audit.
- Enforcement is injected-context guidance only: no runtime gate, no tool restriction, no phase split.
- Off by default (`--pivot-inspection-enforcement` opt-in); the legacy PIVOT_CHECK policy is untouched.
- No retrieval/scoring/ranking/candidate-gen/pivot-selection change.
