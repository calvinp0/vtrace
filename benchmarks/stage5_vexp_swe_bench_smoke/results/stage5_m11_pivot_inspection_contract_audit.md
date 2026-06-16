# Stage 5 M11 — Pivot inspection contract audit

Offline audit of the new **pivot inspection contract** (`src/capsuleV2/pivotInspectionContract.ts`), rendered into the injected Stage 5 Capsule v2 context before the pivot bodies. **Diagnostic only** — no live agents, no Docker, no 30/100-case runs, and no retrieval/scoring/ranking/candidate-gen change (proven below: retrieval evals byte-identical). The contract is a pure render-time projection over the capsule's selected pivots + its multi-file co-edit hint; it never touches retrieval.

## What the contract does

When a capsule has ≥2 pivots (or a `multi_file_coedit` hint fired), it renders a compact checklist: the lead pivot as **inspect-first**, then every **non-lead pivot** and every **related co-edit candidate** as an explicit *edit-it-or-rule-it-out* obligation. When a co-edit hint fired it adds the stronger **final-diff** obligation. Single-pivot capsules with no co-edit hint render nothing (no bloat). It is an injected-context contract — not a runtime gate, not a tool restriction.

## Recovery method

Each case is recovered with current code from a captured `.vtrace/index.sqlite` (task replayed from `_run.meta.json`) where a live index remains; otherwise from the captured `_capsule_v2_manifest.json` selection (+ sibling `_capsule_v2_context.md` for generated-artifact files). The co-edit detector is the same function the build uses, so it reproduces the hint from the captured selection.

## Per-case result

| case | source | pivots | multi_file_coedit? | contract rendered? | non-lead pivots listed | related co-edit listed | contract position | expected effect | risk |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| **sphinx-7462** | live index (current code) | 2 | yes (Path A, high) | yes | `sphinx/pycode/ast.py::unparse` | — | char 685 (first pivot body at 2416); before 12000 cutoff | non-lead pivot(s) + related co-edit candidate(s) become an explicit inspect-or-rule-out obligation with a final-diff requirement (was passive context) | low — every listed file is a selected pivot |
| **seaborn-3187** | live index (current code) | 2 | yes (Path A, high) | yes | `seaborn/relational.py::scatterplot` | — | char 685 (first pivot body at 2408); before 12000 cutoff | non-lead pivot(s) + related co-edit candidate(s) become an explicit inspect-or-rule-out obligation with a final-diff requirement (was passive context) | low — every listed file is a selected pivot |
| **django-13195** | live index (current code) | 2 | yes (Path B, medium) | yes | `django/http/response.py::set_cookie` | `django/contrib/sessions/middleware.py`, `django/contrib/messages/storage/cookie.py` | char 723 (first pivot body at 3294); before 12000 cutoff | non-lead pivot(s) + related co-edit candidate(s) become an explicit inspect-or-rule-out obligation with a final-diff requirement (was passive context) | medium — co-edit support coupling is inferred |
| **astropy-14369** (control) | live index (current code) | 2 | no | yes | `astropy/units/format/cds.py::to_string` | — | char 685 (first pivot body at 2385); before 12000 cutoff | non-lead pivot becomes an explicit inspect-or-rule-out obligation; NO co-edit/final-diff obligation fires (single-file / same-module fix) | low — basic inspect-or-rule-out only; both pivots are real edit-capable files |
| **sympy-16766** (control) | live index (current code) | 2 | no | yes | `sympy/printing/printer.py::_print` | — | char 723 (first pivot body at 1331); before 12000 cutoff | non-lead pivot becomes an explicit inspect-or-rule-out obligation; NO co-edit/final-diff obligation fires (single-file / same-module fix) | low — basic inspect-or-rule-out only; both pivots are real edit-capable files |
| **requests-5414** (control) | live index (current code) | 2 | no | yes | `requests/api.py::get` | — | char 685 (first pivot body at 1285); before 12000 cutoff | non-lead pivot becomes an explicit inspect-or-rule-out obligation; NO co-edit/final-diff obligation fires (single-file / same-module fix) | low — basic inspect-or-rule-out only; both pivots are real edit-capable files |

## Per-case detail

### sphinx-7462
- recovery: live index (current code) (run `eval-bounded-current-clean-sphinx-7462-r1`)
- hidden ast.py::unparse pivot ignored in all M10.1 runs
- pivots: 2 — lead `sphinx/domains/python.py::_parse_annotation`
- non-lead pivots (inspect-or-rule-out): `sphinx/pycode/ast.py::unparse`
- multi_file_coedit hint: yes (Path A, high) → related `sphinx/pycode/ast.py`
- related co-edit candidates in contract: —
- contract rendered: yes (934 chars)
- position: char 685 (first pivot body at 2416); before 12000 cutoff

### seaborn-3187
- recovery: live index (current code) (run `eval-bounded20-current-clean-seaborn-3187-r1`)
- cross-module pivot ignored; only lead edited
- pivots: 2 — lead `seaborn/_core/scales.py::_setup`
- non-lead pivots (inspect-or-rule-out): `seaborn/relational.py::scatterplot`
- multi_file_coedit hint: yes (Path A, high) → related `seaborn/relational.py`
- related co-edit candidates in contract: —
- contract rendered: yes (933 chars)
- position: char 685 (first pivot body at 2408); before 12000 cutoff

### django-13195
- recovery: live index (current code) (run `eval-bounded20-current-clean-django-13195-r1`)
- co-edit improved 0/3 -> 3/3 once related files concrete
- pivots: 2 — lead `django/http/response.py::delete_cookie`
- non-lead pivots (inspect-or-rule-out): `django/http/response.py::set_cookie`
- multi_file_coedit hint: yes (Path B, medium) → related `django/contrib/sessions/middleware.py`, `django/contrib/messages/storage/cookie.py`
- related co-edit candidates in contract: `django/contrib/sessions/middleware.py`, `django/contrib/messages/storage/cookie.py`
- contract rendered: yes (1718 chars)
- position: char 723 (first pivot body at 3294); before 12000 cutoff

### astropy-14369 (control)
- recovery: live index (current code) (run `eval-capsulev2-recovered-live-astropy-14369`)
- generated-artifact (PLY parser table) case
- pivots: 2 — lead `astropy/units/format/vounit.py::VOUnit`
- non-lead pivots (inspect-or-rule-out): `astropy/units/format/cds.py::to_string`
- multi_file_coedit hint: no
- related co-edit candidates in contract: —
- contract rendered: yes (620 chars)
- position: char 685 (first pivot body at 2385); before 12000 cutoff

### sympy-16766 (control)
- recovery: live index (current code) (run `eval-bounded-current-clean-sympy-16766-r1`)
- single-module multi-pivot fix
- pivots: 2 — lead `sympy/printing/pycode.py::PythonCodePrinter`
- non-lead pivots (inspect-or-rule-out): `sympy/printing/printer.py::_print`
- multi_file_coedit hint: no
- related co-edit candidates in contract: —
- contract rendered: yes (608 chars)
- position: char 723 (first pivot body at 1331); before 12000 cutoff

### requests-5414 (control)
- recovery: live index (current code) (run `eval-bounded-current-clean-requests-5414-r1`)
- patch-synthesis-bound; no cross-module co-edit
- pivots: 2 — lead `requests/models.py::prepare_url`
- non-lead pivots (inspect-or-rule-out): `requests/api.py::get`
- multi_file_coedit hint: no
- related co-edit candidates in contract: —
- contract rendered: yes (600 chars)
- position: char 685 (first pivot body at 1285); before 12000 cutoff

## Success criteria

| # | criterion | result |
| --- | --- | --- |
| 1 | sphinx-7462 has an early contract listing `ast.py::unparse` | ✅ |
| 2 | seaborn-3187 has an early pivot/co-edit inspection contract | ✅ |
| 3 | django-13195 has an early contract listing the co-edit candidates | ✅ |
| 4 | generated-artifact hints preserved; tables not confused as co-edit pivots | ✅ (astropy co-edit hint suppressed; generated-artifact hints unchanged by this change) |
| 5 | single-pivot cases not bloated | ✅ (gate: ≥2 pivots OR a co-edit hint; unit-tested) |
| 6 | contract survives Stage 5 truncation | ✅ (rendered before bodies; unit test inflates a body >12k and asserts the contract stays < the cutoff) |
| 7 | retrieval evals byte-identical | ✅ (verified separately; this is render-only) |

## Controls — why they avoid the co-edit obligation

- **astropy-14369**: 2 pivots in one module; `cds.py` is generated-artifact-covered and suppressed → no `multi_file_coedit`. The contract still renders the basic inspect-or-rule-out for the non-lead source pivot, while the generated parser tables stay in the separate generated-artifact hints (never listed as co-edit pivots).
- **sympy-16766**: 2 pivots in the same module (`sympy/printing`), 1 symbol each → neither Path A (cross-module) nor Path B (sibling multi-symbol) fires. Basic inspect-or-rule-out only.
- **requests-5414**: 2 pivots, same top-level dir / 1 symbol each → no co-edit. Basic inspect-or-rule-out only; no false final-diff obligation on a patch-synthesis-bound fix.

## Non-claims
- No live agents and no Docker were run; this is a deterministic render-time audit only.
- The contract is injected-context guidance only: no checklist gate, no phase split, no tool restriction.
- This changed no retrieval, ranking, scoring, candidate generation, or Capsule v2 pivot selection.
