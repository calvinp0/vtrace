# Stage 5 Pivot Check comparison

_Generated: 2026-06-09T12:04:30.783Z_

_Scope: Stage 5 PIVOT_CHECK before/after comparison: per-pivot engagement (ignored / discovered-only / inspected / edited) for one or more vtrace run-label pairs on a fixed instance. Reporting only — no retrieval, scoring, injection, or run behavior changed._

## Summary

- Compared pairs: 1
- Hidden pivots converted (gained inspection/edit): 1
- Hidden pivots regressed (lost inspection/edit): 0
- Conversion tally:
  - `discovered_only_to_inspected`: 1
  - `unchanged_edited`: 3
  - `unchanged_ignored`: 2

## Compared runs

| instance | before label | after label | treatment valid (before→after) | pivot-check injected (before→after) |
| --- | --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | `eval-pivot-telemetry-vtrace-sphinx-7462-r2` | `eval-pivot-check-vtrace-sphinx-7462` | yes → yes | no → yes |

## Hidden pivot conversion

Per-pivot engagement, before vs. after. `discovered` = surfaced in a search but not opened; `inspected` = the file's contents were read/opened; `edited` = the final patch touched the file. `discovered` alone never counts as inspection.

### sphinx-doc__sphinx-7462

| path | symbol | hidden | before disc | before insp | before edit | before status | after disc | after insp | after edit | after status | conversion |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sphinx/domains/python.py` | `_parse_annotation` | no | no | yes | yes | edited | no | yes | yes | edited | `unchanged_edited` |
| `sphinx/pycode/ast.py` | `unparse` | yes | yes | no | no | ignored | no | yes | no | inspected | `discovered_only_to_inspected` |
| `sphinx/domains/python.py` | `_parse_arglist` | no | no | yes | yes | edited | no | yes | yes | edited | `unchanged_edited` |
| `sphinx/domains/python.py` | `PythonDomain` | no | no | yes | yes | edited | no | yes | yes | edited | `unchanged_edited` |
| `sphinx/application.py` | `Sphinx` | no | no | no | no | ignored | no | no | no | ignored | `unchanged_ignored` |
| `sphinx/application.py` | `add_js_file` | no | no | no | no | ignored | no | no | no | ignored | `unchanged_ignored` |

Hidden-pivot counts — before: ignored 1 (discovered-only 1), inspected 0, edited 0; after: ignored 0 (discovered-only 0), inspected 1, edited 0.

## Tool evidence

Checklist emission is the agent echoing a PIVOT_CHECK section; it is NOT the source of truth. Ordered tool evidence (`_tool_calls.json`) is. A run can show `checklist emitted: no` while tool evidence still shows direct inspection.

| instance | tool log ordered (before→after) | tool calls (before→after) | checklist emitted (before→after) |
| --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | yes → yes | 6 → 11 | — → no |

## Cost / token delta

Delta is after − before (positive = the after run spent more).

| instance | before tokens | after tokens | token Δ | token Δ% | before cost | after cost | cost Δ | cost Δ% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | 581546 | 1034743 | +453197 | +77.9% | $0.2172 | $0.4234 | $0.2063 | +95.0% |

## Patch / resolution outcome

| instance | before resolved | after resolved | resolved changed | edited files before | edited files after |
| --- | --- | --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | not evaluated | not evaluated | no | sphinx/domains/python.py | sphinx/domains/python.py |

## Interpretation

On sphinx-7462, PIVOT_CHECK converted the hidden pivot from discovered-only / ignored to inspected. Docker resolution and patch correctness remain separate outcomes.

## Non-claims

This report does NOT claim:

- PIVOT_CHECK improves Docker resolution.
- PIVOT_CHECK guarantees correct edits.
- Checklist emission is required for compliance.
- One sphinx-7462 run proves broad benchmark improvement.
- This is a public SWE-bench result.

