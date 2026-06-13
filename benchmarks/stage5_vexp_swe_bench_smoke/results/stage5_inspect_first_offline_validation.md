# Stage 5 — Compact Capsule v2 injected context: offline validation

Deterministic offline replay (no live agents, no Docker). Each instance's exact
task is recovered from a completed run's `_run.meta.json` `vtraceQueryCommand`
and rebuilt through `buildCapsuleV2` (`--intent auto`, budget 8,000) — the same
Capsule v2 the vtrace-indexed single-shot path injects. **before** = the
previously-shipped injected text (human capsule + verbose neighborhood, excerpt
bodies inlined). **after** = the new compact text (inspect-first guidance +
human capsule + compact neighborhood reference list). Tokens are `ceil(chars/4)`
estimates of the agent-facing text, not tokenizer truth.

## Per-instance result

| Instance | inspect-first | confidence | likely first | before tok | after tok | Δ tok | verbose reduced | structured kept |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| matplotlib__matplotlib-22719 | yes | high | lib/matplotlib/category.py::convert | 1867 | 1400 | -467 | yes | yes |
| astropy__astropy-14369 | yes | medium | astropy/units/format/cds.py::to_string | 3844 | 3560 | -284 | yes | yes |
| django__django-10880 | yes | medium | django/db/models/query.py::count | 1700 | 1294 | -406 | yes | yes |
| django__django-11095 | yes | medium | django/contrib/admin/options.py::get_inline_formsets | 1949 | 1610 | -339 | yes | yes |

## Per-instance detail

### matplotlib__matplotlib-22719
- task chars=7999; pivots=2; support=4; excerpts=8
- likely first file: lib/matplotlib/category.py::convert (confidence: high)
- related context: lib/matplotlib/axis.py::convert_units (surface); lib/matplotlib/_api/deprecation.py::warn_deprecated
- injected tokens (est): 1867 → 1400 (-467)
- verbose pivot-neighborhood reduced: yes
- full structured pivotNeighborhood excerpt bodies retained: yes

### astropy__astropy-14369
- task chars=5043; pivots=2; support=4; excerpts=8
- likely first file: astropy/units/format/cds.py::to_string (confidence: medium)
- related context: astropy/units/format/vounit.py::VOUnit (surface); astropy/coordinates/matching.py::_get_cartesian_kdtree
- injected tokens (est): 3844 → 3560 (-284)
- verbose pivot-neighborhood reduced: yes
- full structured pivotNeighborhood excerpt bodies retained: yes

### django__django-10880
- task chars=562; pivots=2; support=4; excerpts=8
- likely first file: django/db/models/query.py::count (confidence: medium)
- related context: django/db/models/functions/comparison.py::Least; django/core/paginator.py::count
- injected tokens (est): 1700 → 1294 (-406)
- verbose pivot-neighborhood reduced: yes
- full structured pivotNeighborhood excerpt bodies retained: yes

### django__django-11095
- task chars=1303; pivots=2; support=4; excerpts=8
- likely first file: django/contrib/admin/options.py::get_inline_formsets (confidence: medium)
- related context: django/contrib/contenttypes/admin.py::GenericTabularInline; django/contrib/admin/checks.py::_check_list_display_links_item
- injected tokens (est): 1949 → 1610 (-339)
- verbose pivot-neighborhood reduced: yes
- full structured pivotNeighborhood excerpt bodies retained: yes

## Non-claims
- No live agents and no Docker were run; this is a deterministic first-response measurement only.
- Token figures are `chars/4` estimates of agent-facing text, not tokenizer truth or live-run totals.
- This changed no retrieval, ranking, scoring, candidate generation, or the solve protocol; Capsule v2 stays opt-in.
- The inspect-first block is guidance only (no checklist, no gate, no phase split, no tool restriction).
