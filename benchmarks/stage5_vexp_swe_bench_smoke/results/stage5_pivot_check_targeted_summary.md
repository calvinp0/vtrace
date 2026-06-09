# Stage 5 Pivot Check comparison

_Generated: 2026-06-09T16:39:47.150Z_

_Scope: Stage 5 PIVOT_CHECK before/after comparison: per-pivot engagement (ignored / discovered-only / inspected / edited) for one or more vtrace run-label pairs on a fixed instance. Reporting only — no retrieval, scoring, injection, or run behavior changed._

## Summary

- Compared targeted pairs: 2
- Hidden pivots converted to inspected: 2
- Hidden pivots converted to edited: 0
- Hidden pivots converted (gained inspection/edit): 2
- Hidden pivots regressed (lost inspection/edit): 0
- Edited-file-set changes: 0
- Cost increased: 2/2
- Token count increased: 2/2
- Docker evaluated: no / not in these reports
- Conversion tally:
  - `discovered_only_to_inspected`: 2
  - `ignored_to_inspected`: 1
  - `unchanged_edited`: 5
  - `unchanged_ignored`: 4

## Targeted summary

| instance | hidden pivot conversion | before edited files | after edited files | edited-file set changed | token Δ% | cost Δ% |
| --- | --- | --- | --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | discovered_only_to_inspected | sphinx/domains/python.py | sphinx/domains/python.py | no | +77.9% | +95.0% |
| mwaskom__seaborn-3187 | discovered_only_to_inspected | seaborn/_core/scales.py, seaborn/utils.py | seaborn/_core/scales.py, seaborn/utils.py | no | +35.4% | +7.3% |

## Compared runs

| instance | before label | after label | treatment valid (before→after) | pivot-check injected (before→after) | PIVOT_CHECK state (before→after) |
| --- | --- | --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | `eval-pivot-telemetry-vtrace-sphinx-7462-r2` | `eval-pivot-check-vtrace-sphinx-7462` | yes → yes | no → yes | not injected → injected |
| mwaskom__seaborn-3187 | `eval-pivot-telemetry-vtrace-seaborn-3187-no-pivot-check` | `eval-pivot-check-vtrace-seaborn-3187` | yes → yes | no → yes | disabled (flag) → injected |

PIVOT_CHECK state disambiguates a controlled before run from a failed injection: `disabled (flag)` = the run passed `--disable-pivot-check` (a deliberate before condition); `enabled, not injected` = PIVOT_CHECK was on but no block was emitted (e.g. a single-pivot capsule); `injected` = the block was present.

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

### mwaskom__seaborn-3187

| path | symbol | hidden | before disc | before insp | before edit | before status | after disc | after insp | after edit | after status | conversion |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `seaborn/_core/scales.py` | `_setup` | no | no | yes | yes | edited | no | yes | yes | edited | `unchanged_edited` |
| `seaborn/relational.py` | `scatterplot` | yes | yes | no | no | ignored | no | yes | no | inspected | `discovered_only_to_inspected` |
| `seaborn/utils.py` | `load_dataset` | no | no | yes | yes | edited | no | yes | yes | edited | `unchanged_edited` |
| `seaborn/_core/plot.py` | `Plot` | no | no | no | no | ignored | no | yes | no | inspected | `ignored_to_inspected` |
| `examples/grouped_barplot.py` | `penguins` | no | no | no | no | ignored | no | no | no | ignored | `unchanged_ignored` |
| `examples/joint_kde.py` | `penguins` | no | no | no | no | ignored | no | no | no | ignored | `unchanged_ignored` |

Hidden-pivot counts — before: ignored 1 (discovered-only 1), inspected 0, edited 0; after: ignored 0 (discovered-only 0), inspected 1, edited 0.

## Tool evidence

Checklist emission is the agent echoing a PIVOT_CHECK section; it is NOT the source of truth. Ordered tool evidence (`_tool_calls.json`) is. A run can show `checklist emitted: no` while tool evidence still shows direct inspection.

| instance | tool log ordered (before→after) | tool calls (before→after) | checklist emitted (before→after) |
| --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | yes → yes | 6 → 11 | — → no |
| mwaskom__seaborn-3187 | yes → yes | 23 → 29 | no → no |

## Cost / token delta

Delta is after − before (positive = the after run spent more).

| instance | before tokens | after tokens | token Δ | token Δ% | before cost | after cost | cost Δ | cost Δ% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | 581546 | 1034743 | +453197 | +77.9% | $0.2172 | $0.4234 | $0.2063 | +95.0% |
| mwaskom__seaborn-3187 | 2444167 | 3308810 | +864643 | +35.4% | $1.0404 | $1.1158 | $0.0754 | +7.3% |

## Patch / resolution outcome

| instance | before resolved | after resolved | resolved changed | edited files before | edited files after |
| --- | --- | --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | not evaluated | not evaluated | no | sphinx/domains/python.py | sphinx/domains/python.py |
| mwaskom__seaborn-3187 | not evaluated | not evaluated | no | seaborn/_core/scales.py, seaborn/utils.py | seaborn/_core/scales.py, seaborn/utils.py |

## Edit-relevance subset

The targeted cases should not all be counted as edit-target-conversion failures. "Converted to inspected" is a telemetry fact for every hidden pivot; "converted to edited" is only meaningful for hidden pivots that were actually edit-relevant.

Edit-relevance below is CURATED post-inspection analysis (the analyst's gold/edit relevance label), not derived from the run's tool telemetry. See `stage5_pivot_check_post_inspection_analysis.md` for the per-case evidence.

| instance | hidden pivot | classification | edit-relevant hidden pivot? | inspected after PIVOT_CHECK | edited after PIVOT_CHECK | implication |
| --- | --- | --- | --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | `sphinx/pycode/ast.py::unparse` | `failed_to_connect_to_edit` | yes | yes | no | one edit-planning miss |
| mwaskom__seaborn-3187 | `seaborn/relational.py::scatterplot` | `not_actually_edit_relevant` | no | yes | no | correct/no-edit context or weak edit-conversion evidence |

Headline numbers (telemetry + curated):

- Targeted PIVOT_CHECK pairs: 2
- Hidden pivots converted to inspected: 2
- Known edit-relevant hidden pivots inspected: 1
- Known edit-relevant hidden pivots converted to edited: 0
- Known non-edit-relevant hidden pivots inspected: 1
- Effective N for edit-target conversion: 1

## Interpretation

Across the 2 targeted cases, PIVOT_CHECK consistently enforced hidden-pivot inspection (2/2 converted to inspected). For edit-target conversion the effective sample is only 1 case(s): sphinx-doc__sphinx-7462. In that edit-relevant case, inspection did not lead to editing the hidden pivot. The other inspected hidden pivot(s) (mwaskom__seaborn-3187) were not actually edit targets, so they should not be counted as failures to convert inspection into editing. Docker resolution and patch correctness remain separate, unevaluated outcomes.

## Non-claims

This report does NOT claim:

- PIVOT_CHECK improves Docker resolution.
- PIVOT_CHECK guarantees correct edits.
- PIVOT_CHECK should be broadly enabled by default.
- Checklist emission is required for compliance.
- One or a small number of targeted live runs do not prove broad benchmark improvement.
- This is a public SWE-bench result.

